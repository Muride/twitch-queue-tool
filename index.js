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
const REDIRECT_URI = 'http://localhost:3000/auth/callback';

let state = {
    waiting: [],
    active: [],
    completed: [],
    partySize: 2,
    rewardTitle: "参加券", 
    isConnected: false,
    channelName: ""
};

let chatClientInstance = null;
let chatUpdateTimer = null;
let lastTaikiCommandTime = 0; // !taiki連打防止用

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
        listener.start();
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

// --- チャットコマンド制御 ---
function setupChatEvents(chatClient) {
    chatClient.onMessage((channel, user, text, msg) => {
        const userInfo = { id: user, name: msg.userInfo.displayName };

        // !sanka (一応残していますが、ポイント制にするなら無効化してもOK)
        if (text === '!sanka') {
            addUserToWait(userInfo);
            broadcast(true);
        }
        
        // ★VIP専用参加コマンド
        if (text === '!vipsanka') {
             // isVip: VIPバッジ, isMod: 剣マーク, isBroadcaster: 配信者本人
             if (msg.userInfo.isVip || msg.userInfo.isMod || msg.userInfo.isBroadcaster) {
                 addUserToWait(userInfo);
                 chatClient.say(channel, `👑 VIPの ${userInfo.name} さんが参加希望しました！`);
                 broadcast(true);
             } else {
                 // VIPじゃない人が打った場合（反応しないか、注意するか。今回はコンソール表示のみ）
                 console.log(`[拒否] ${userInfo.name} はVIPではありません`);
             }
        }

        // ★待機状況確認コマンド
        if (text === '!taiki') {
            const now = Date.now();
            // 前回の実行から10秒(10000ms)経っていれば実行
            if (now - lastTaikiCommandTime > 10000) {
                lastTaikiCommandTime = now;
                sendUpdateToChat();
            } else {
                console.log("!taiki クールダウン中");
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
});

if(fs.existsSync('./tokens.json')) startBot();
server.listen(3000, () => { console.log('http://localhost:3000 で管理ツール稼働中'); });