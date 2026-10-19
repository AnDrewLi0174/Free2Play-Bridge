const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Serve static client assets
app.use(express.static(path.join(__dirname, '/')));

const SUITS = ['♣', '♦', '♥', '♠'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const PLAYERS = ['North', 'East', 'South', 'West'];
const SUIT_ORDER = { '♣': 1, '♦': 2, '♥': 3, '♠': 4, 'NT': 5 };

// Active game rooms state
const rooms = {};

function generateDeck() {
    const deck = [];
    SUITS.forEach(suit => {
        RANKS.forEach((rank, idx) => {
            deck.push({ suit, rank, value: idx + 2 });
        });
    });
    // Fisher-Yates Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function sortHand(hand) {
    return hand.sort((a, b) => {
        if (SUIT_ORDER[a.suit] !== SUIT_ORDER[b.suit]) {
            return SUIT_ORDER[b.suit] - SUIT_ORDER[a.suit];
        }
        return b.value - a.value;
    });
}

function createGameState(roomId) {
    const deck = generateDeck();
    const hands = {
        North: sortHand(deck.slice(0, 13)),
        East: sortHand(deck.slice(13, 26)),
        South: sortHand(deck.slice(26, 39)),
        West: sortHand(deck.slice(39, 52))
    };

    return {
        id: roomId,
        handNumber: 1,
        dealerIdx: 0, // North starts
        currentTurnIdx: 0,
        hands: hands,
        phase: 'BIDDING',
        auction: [],
        passesInRow: 0,
        contract: null,
        declarer: null,
        dummy: null,
        currentTrick: [],
        leadSuit: null,
        tricksWon: { 'N-S': 0, 'E-W': 0 },
        trickHistory: []
    };
}

io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Join or create a room
    socket.on('joinRoom', ({ roomId, playerName }) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = createGameState(roomId);
        }

        const roomState = rooms[roomId];
        socket.emit('gameStateUpdate', roomState);
        io.to(roomId).emit('playerJoined', { playerId: socket.id, playerName });
    });

    // Handle Bidding Calls
    socket.on('makeCall', ({ roomId, player, callStr }) => {
        const gameState = rooms[roomId];
        if (!gameState || gameState.phase !== 'BIDDING') return;

        gameState.auction.push({ player, call: callStr });

        if (callStr === 'Pass') {
            gameState.passesInRow++;
        } else {
            gameState.passesInRow = 0;
        }

        const hasAnyBid = gameState.auction.some(a => a.call !== 'Pass');
        if ((hasAnyBid && gameState.passesInRow === 3) || (!hasAnyBid && gameState.passesInRow === 4)) {
            // Finalize Auction
            const lastBid = [...gameState.auction].reverse().find(a => a.call !== 'Pass');
            if (!lastBid) {
                // Passed out -> redeal
                rooms[roomId] = createGameState(roomId);
            } else {
                const level = parseInt(lastBid.call[0]);
                const suit = lastBid.call.substring(1);
                const declarer = lastBid.player;
                const declarerIdx = PLAYERS.indexOf(declarer);

                gameState.contract = { level, suit, declarer };
                gameState.declarer = declarer;
                gameState.dummy = PLAYERS[(declarerIdx + 2) % 4];
                gameState.phase = 'PLAYING';
                gameState.currentTurnIdx = (declarerIdx + 1) % 4; // Leader is left of declarer
            }
        } else {
            gameState.currentTurnIdx = (gameState.currentTurnIdx + 1) % 4;
        }

        io.to(roomId).emit('gameStateUpdate', gameState);
    });

    // Handle Card Play
    socket.on('playCard', ({ roomId, player, cardIndex }) => {
        const gameState = rooms[roomId];
        if (!gameState || gameState.phase !== 'PLAYING') return;

        const hand = gameState.hands[player];
        if (!hand || !hand[cardIndex]) return;

        const playedCard = hand.splice(cardIndex, 1)[0];
        
        if (gameState.currentTrick.length === 0) {
            gameState.leadSuit = playedCard.suit;
        }

        gameState.currentTrick.push({ player, card: playedCard });

        // Resolve trick when 4 cards played
        if (gameState.currentTrick.length === 4) {
            let winningPlay = gameState.currentTrick[0];
            const trumpSuit = gameState.contract.suit;
            const leadSuit = gameState.leadSuit;

            for (let i = 1; i < 4; i++) {
                const candidate = gameState.currentTrick[i];
                if (trumpSuit !== 'NT' && candidate.card.suit === trumpSuit) {
                    if (winningPlay.card.suit !== trumpSuit || candidate.card.value > winningPlay.card.value) {
                        winningPlay = candidate;
                    }
                } else if (candidate.card.suit === leadSuit && winningPlay.card.suit === leadSuit) {
                    if (candidate.card.value > winningPlay.card.value) {
                        winningPlay = candidate;
                    }
                }
            }

            const winner = winningPlay.player;
            const winningTeam = (winner === 'North' || winner === 'South') ? 'N-S' : 'E-W';
            gameState.tricksWon[winningTeam]++;
            gameState.trickHistory.push({ trick: [...gameState.currentTrick], winner });

            gameState.currentTurnIdx = PLAYERS.indexOf(winner);
            gameState.currentTrick = [];
            gameState.leadSuit = null;

            // Check if hand finished
            if (gameState.hands['South'].length === 0) {
                gameState.phase = 'FINISHED';
            }
        } else {
            gameState.currentTurnIdx = (gameState.currentTurnIdx + 1) % 4;
        }

        io.to(roomId).emit('gameStateUpdate', gameState);
    });

    // Start New Deal
    socket.on('newDeal', ({ roomId }) => {
        if (rooms[roomId]) {
            const currentHandNo = rooms[roomId].handNumber + 1;
            const nextDealer = (rooms[roomId].dealerIdx + 1) % 4;
            rooms[roomId] = createGameState(roomId);
            rooms[roomId].handNumber = currentHandNo;
            rooms[roomId].dealerIdx = nextDealer;
            rooms[roomId].currentTurnIdx = nextDealer;
            io.to(roomId).emit('gameStateUpdate', rooms[roomId]);
        }
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`Bridge Project Server running on http://localhost:${PORT}`);
});