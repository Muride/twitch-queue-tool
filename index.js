require('dotenv').config();
const fs = require('fs');
const http = require('http');
const https = require('https'); // 自身の生存確認用に追加
const crypto = require('crypto'); // パスワード照合・ランダム文字列用
const express = require('express');
const session = require('express-session');
const { Server } = require("socket.io");
const { RefreshingAuthProvider, exchangeCode } = require('@twurple/auth');
const { ChatClient } = require('@twurple/chat');
const { ApiClient } = require('@twurple/api');
const { EventSubWsListener } = require('@twurple/eventsub-ws');

// --- 管理画面の合言葉（Renderの環境変数で設定する） ---
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!ADMIN_USER || !ADMIN_PASS || !SESSION_SECRET) {
    // 設定し忘れたまま「誰でも入れる状態」で動かないよう、起動を止める
    console.error("ADMIN_USER / ADMIN_PASS / SESSION_SECRET が設定されていません。起動を中止します。");
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Render は手前に中継サーバーがいるので、それを信用する（https判定のため）
app.set('trust proxy', 1);

// ★Render生存確認用エンドポイント（ここを叩くとスリープしない）※合言葉なしで通す
app.get('/health', (req, res) => {
    res.send('OK');
});

// セッション：一度合言葉が通ったら、しばらく覚えておく
const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 1000 * 60 * 60 * 12 } // 12時間
});
app.use(sessionMiddleware);

// 文字列を、かかる時間から中身を推測されない方法で比べる
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// Basic認証：ID・パスワードが合っている人だけ通す
function basicAuth(req, res, next) {
    if (req.session && req.session.isAdmin) return next();

    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        const sep = decoded.indexOf(':');
        if (sep !== -1) {
            const userOk = safeEqual(decoded.slice(0, sep), ADMIN_USER);
            const passOk = safeEqual(decoded.slice(sep + 1), ADMIN_PASS);
            if (userOk && passOk) {
                req.session.isAdmin = true;
                return next();
            }
        }
    }
    res.set('WWW-Authenticate', 'Basic realm="twitch-queue-tool", charset="UTF-8"');
    res.status(401).send('認証が必要です');
}
app.use(basicAuth);

app.use(express.static('public'));
app.use(express.json());

// Socket.io（画面とのやりとり）も、合言葉が通った人だけ受け付ける
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
    if (socket.request.session && socket.request.session.isAdmin) return next();
    next(new Error('unauthorized'));
});

// --- 設定値 ---
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
// ★RenderのURLになっているか確認してください
const REDIRECT_URI = 'https://twitch-queue-tool.onrender.com/auth/callback';

let state = {
    waiting: [],
    active: [],
    completed: [],
    partySize: 2,
    rewardTitle: "参加券", 
    isConnected: false,
    channelName: ""
};

// インスタンス保持用
let chatClientInstance = null;
let eventSubListenerInstance = null;
let chatUpdateTimer = null;
let lastTaikiCommandTime = 0;
let keepAliveInterval = null; // スリープ防止タイマー

// --- 認証フロー ---
app.get('/auth_status', (req, res) => {
    const hasToken = fs.existsSync('./tokens.json');
    res.json({ loggedIn: hasToken && state.isConnected, channel: state.channelName });
});

app.get('/auth/login', (req, res) => {
    const scopes = ['chat:read', 'chat:edit', 'channel:read:redemptions'];
    // なりすまし防止：ランダムな合言葉を持たせて、戻ってきたときに照合する
    const oauthState = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = oauthState;
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${scopes.join('+')}&state=${oauthState}`;
    res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("Error: No code provided");

    const expected = req.session.oauthState;
    delete req.session.oauthState;
    if (!expected || req.query.state !== expected) {
        return res.status(400).send("認証エラー：もう一度トップページからログインしてください");
    }

    try {
        const tokenData = await exchangeCode(CLIENT_ID, CLIENT_SECRET, code, REDIRECT_URI);
        fs.writeFileSync('./tokens.json', JSON.stringify(tokenData, null, 4), 'UTF-8');
        await startBot();
        res.redirect('/');
    } catch (e) {
        console.error(e);
        res.send("認証失敗: " + e.message);
    }
});


// --- Bot起動 ---
async function startBot() {
    if (state.isConnected) return;

    try {
        console.log("Bot起動プロセス開始...");
        if (!fs.existsSync('./tokens.json')) throw new Error("トークンファイルがありません");

        const tokenData = JSON.parse(fs.readFileSync('./tokens.json', 'UTF-8'));
        
        // 1. ユーザー特定
        const userInfo = await fetchUserInfoManual(tokenData.accessToken);
        console.log(`ユーザー特定成功: ${userInfo.login} (ID: ${userInfo.id})`);
        state.channelName = userInfo.login;

        // 2. AuthProvider
        const authProvider = new RefreshingAuthProvider({
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            onRefresh: async (userId, newTokenData) => {
                fs.writeFileSync('./tokens.json', JSON.stringify(newTokenData, null, 4), 'UTF-8');
            }
        });
        await authProvider.addUser(userInfo.id, tokenData, ['chat']);

        // 3. ApiClient
        const apiClient = new ApiClient({ authProvider });

        // 4. ChatClient
        const chatClient = new ChatClient({ authProvider, channels: [state.channelName] });
        await chatClient.connect();
        chatClientInstance = chatClient;

        // 5. EventSub (ポイント検知)
        const listener = new EventSubWsListener({ apiClient });
        await listener.start();
        eventSubListenerInstance = listener;
        console.log("EventSub(ポイント検知) 待機中...");

        listener.onChannelRedemptionAdd(userInfo.id, (event) => {
            console.log(`ポイント検知: ${event.rewardTitle} by ${event.userDisplayName}`);
            if (event.rewardTitle === state.rewardTitle) {
                const userObj = { id: event.userId, name: event.userDisplayName };
                addUserToWait(userObj);
                chatClient.say(state.channelName, `${event.userDisplayName} さんの「${event.rewardTitle}」を確認しました！`);
                broadcast(true);
            }
        });

        setupChatEvents(chatClient);
        
        // ★ここが重要：スリープ防止機能をONにする
        startKeepAlive();
        
        state.isConnected = true;
        console.log(`全システム稼働完了！ Channel: ${state.channelName}`);
        io.emit('connection_status', { connected: true, channel: state.channelName });

    } catch (e) {
        console.error("Bot起動失敗:", e);
        state.isConnected = false;
    }
}

// ★自分自身に5分ごとにアクセスしてRenderを叩き起こす関数
function startKeepAlive() {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    
    // 自分のURL（/health）を作成
    // ※注意: 環境変数などが無いので、REDIRECT_URIからドメインを推測しています
    const targetUrl = REDIRECT_URI.replace('/auth/callback', '/health'); 
    console.log(`キープアライブ開始: ${targetUrl} を5分ごとに叩きます`);

    keepAliveInterval = setInterval(() => {
        https.get(targetUrl, (res) => {
            // 成功時は特にログを出さない（ログが汚れるため）
        }).on('error', (e) => {
            console.error(`Keep-Alive Error: ${e.message}`);
        });
    }, 5 * 60 * 1000); // 5分間隔
}

async function fetchUserInfoManual(accessToken) {
    const response = await fetch('https://api.twitch.tv/helix/users', {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Client-Id': CLIENT_ID }
    });
    if (!response.ok) throw new Error(await response.text());
    const json = await response.json();
    return json.data[0];
}

function setupChatEvents(chatClient) {
    chatClient.onMessage((channel, user, text, msg) => {
        const userInfo = { id: user, name: msg.userInfo.displayName };

        if (text === '!vipsanka') {
             if (msg.userInfo.isVip || msg.userInfo.isMod || msg.userInfo.isBroadcaster) {
                 addUserToWait(userInfo);
                 chatClient.say(channel, `👑 VIPの ${userInfo.name} さんが参加希望しました！`);
                 broadcast(true);
             }
        }

        if (text === '!taiki') {
            const now = Date.now();
            if (now - lastTaikiCommandTime > 10000) {
                lastTaikiCommandTime = now;
                sendUpdateToChat();
            }
        }
    });
}

function addUserToWait(userInfo) {
    const exists = 
        state.waiting.some(u => u.id === userInfo.id) || 
        state.active.some(u => u.id === userInfo.id) ||
        state.completed.some(u => u.id === userInfo.id);

    if (!exists) state.waiting.push(userInfo);
}

function scheduleChatUpdate() {
    if (chatUpdateTimer) clearTimeout(chatUpdateTimer);
    chatUpdateTimer = setTimeout(() => sendUpdateToChat(), 5000);
}

function sendUpdateToChat() {
    if (!chatClientInstance || !state.isConnected) return;
    const pSize = state.partySize;
    let msg = "♪参加状況♪ ";
    
    if (state.waiting.length === 0) {
        msg += "現在待機はいません。参加者募集中！";
    } else {
        const waitList = [...state.waiting];
        let groupIndex = 1;
        while(waitList.length > 0) {
            const group = waitList.splice(0, pSize);
            const names = group.map(u => u.name).join(', ');
            if (groupIndex === 1) msg += `【次：${names}】`;
            else {
                const emptySlots = pSize - group.length;
                let slotInfo = emptySlots > 0 ? `、${emptySlots}人空きです！` : "";
                msg += `【${groupIndex}枠目：${names}${slotInfo}】`;
            }
            if (msg.length > 300) { msg += `...他${waitList.length}人`; break; }
            groupIndex++;
        }
    }
    chatClientInstance.say(state.channelName, msg);
    io.emit('update_all', state);
}

const broadcast = (triggerChat = false) => {
    io.emit('update_all', state);
    if (triggerChat) scheduleChatUpdate();
};

io.on('connection', (socket) => {
    socket.emit('connection_status', { connected: state.isConnected, channel: state.channelName });
    socket.emit('update_all', state);
    socket.on('manual_add', (name) => {
        if(name) { addUserToWait({ id: name, name: name }); broadcast(true); }
    });
    socket.on('update_settings', (data) => {
        state.partySize = parseInt(data.size);
        state.rewardTitle = data.title;
        broadcast(false);
    });
    socket.on('trigger_party', () => {
        state.completed.push(...state.active);
        state.active = [];
        const moveCount = Math.min(state.partySize, state.waiting.length);
        const newMembers = state.waiting.splice(0, moveCount);
        state.active = newMembers;
        broadcast(true);
    });
    socket.on('move_to_active', (id) => {
        const idx = state.waiting.findIndex(u => u.id === id);
        if(idx !== -1) { state.active.push(state.waiting.splice(idx, 1)[0]); broadcast(true); }
    });
    socket.on('move_to_wait', (id) => {
        let idx = state.active.findIndex(u => u.id === id);
        if(idx !== -1) state.waiting.push(state.active.splice(idx, 1)[0]);
        else {
            idx = state.completed.findIndex(u => u.id === id);
            if(idx !== -1) state.waiting.push(state.completed.splice(idx, 1)[0]);
        }
        broadcast(true);
    });
    socket.on('move_to_completed', (id) => {
        const idx = state.active.findIndex(u => u.id === id);
        if(idx !== -1) { state.completed.push(state.active.splice(idx, 1)[0]); broadcast(true); }
    });
    socket.on('remove_user', (id) => {
        state.waiting = state.waiting.filter(u => u.id !== id);
        state.active = state.active.filter(u => u.id !== id);
        state.completed = state.completed.filter(u => u.id !== id);
        broadcast(true);
    });
    socket.on('reset_all', () => {
        state.waiting = []; state.active = []; state.completed = []; broadcast(true);
    });
    socket.on('update_lists_manual', (newData) => {
        const reorder = (orig, newIds) => {
            const res = []; newIds.forEach(id => { const f = orig.find(u => u.id === id); if(f) res.push(f); }); return res;
        };
        state.waiting = reorder(state.waiting, newData.waiting);
        state.active = reorder(state.active, newData.active);
        broadcast(true);
    });

    // ★ログアウト処理（キープアライブも止める）
    socket.on('logout', async () => {
        console.log("ログアウト処理開始...");
        
        if (keepAliveInterval) clearInterval(keepAliveInterval);

        if (chatClientInstance) {
            await chatClientInstance.quit();
            chatClientInstance = null;
        }
        if (eventSubListenerInstance) {
            eventSubListenerInstance.stop();
            eventSubListenerInstance = null;
        }

        if (fs.existsSync('./tokens.json')) {
            fs.unlinkSync('./tokens.json');
            console.log("tokens.json を削除しました");
        }

        state.isConnected = false;
        state.channelName = "";
        state.waiting = [];
        state.active = [];
        state.completed = [];
        
        io.emit('connection_status', { connected: false, channel: "" });
        console.log("ログアウト完了");
    });
});

if(fs.existsSync('./tokens.json')) startBot();

const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`管理ツール稼働中: Port ${port} / Node ${process.version}`);
});
