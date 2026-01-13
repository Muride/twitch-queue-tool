require('dotenv').config();
const fs = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { Server } = require("socket.io");
const { RefreshingAuthProvider, exchangeCode } = require('@twurple/auth');
const { ChatClient } = require('@twurple/chat');
const { ApiClient } = require('@twurple/api');
const { EventSubWsListener } = require('@twurple/eventsub-ws');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(session({ secret: 'some-secret-key', resave: false, saveUninitialized: true }));
app.use(express.static('public'));
app.use(express.json());

// --- 設定値 ---
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
// ★GitHubに上げる際は、ここがRenderのURLになっているか確認してください
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

// コンポーネント管理用（ログアウト時に停止するため）
let chatClientInstance = null;
let eventSubListenerInstance = null;
let chatUpdateTimer = null;
let lastTaikiCommandTime = 0;

// --- 認証フロー ---
app.get('/auth_status', (req, res) => {
    const hasToken = fs.existsSync('./tokens.json');
    res.json({ loggedIn: hasToken && state.isConnected, channel: state.channelName });
});

app.get('/auth/login', (req, res) => {
    const scopes = ['chat:read', 'chat:edit', 'channel:read:redemptions'];
    const url = `https://id.twitch.tv/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=${scopes.join('+')}`;
    res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("Error: No code provided");

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
        eventSubListenerInstance = listener; // 停止用に保持
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
        
        state.isConnected = true;
        console.log(`全システム稼働完了！ Channel: ${state.channelName}`);
        io.emit('connection_status', { connected: true, channel: state.channelName });

    } catch (e) {
        console.error("Bot起動失敗:", e);
        state.isConnected = false;
        // 起動失敗時、トークンがおかしいならファイルを消す処理を入れても良い
    }
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

        if (text === '!sanka') {
            
        }
        if (text === '!vipsanka') {
             if (msg.userInfo.isVip || msg.userInfo.isMod || msg.userInfo.isBroadcaster) {
                 addUserToWait(userInfo);
                 chatClient.say(channel, `👑 VIPの ${userInfo.name} さんが参加希望しました！`);
                 broadcast(true);
             } else {
                 console.log(`[拒否] ${userInfo.name} はVIPではありません`);
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

    // ★ログアウト処理の追加
    socket.on('logout', async () => {
        console.log("ログアウト処理開始...");
        
        // 1. 各種接続を切断
        if (chatClientInstance) {
            await chatClientInstance.quit();
            chatClientInstance = null;
        }
        if (eventSubListenerInstance) {
            eventSubListenerInstance.stop();
            eventSubListenerInstance = null;
        }

        // 2. トークンファイルの削除
        if (fs.existsSync('./tokens.json')) {
            fs.unlinkSync('./tokens.json');
            console.log("tokens.json を削除しました");
        }

        // 3. 内部状態のリセット
        state.isConnected = false;
        state.channelName = "";
        state.waiting = [];
        state.active = [];
        state.completed = [];
        
        // 4. 全員に通知（ログイン画面に戻すため）
        io.emit('connection_status', { connected: false, channel: "" });
        console.log("ログアウト完了");
    });
});

if(fs.existsSync('./tokens.json')) startBot();

const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`管理ツール稼働中: Port ${port}`);
});

