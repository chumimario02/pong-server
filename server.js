const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: process.env.CLIENT_URL || "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Variables globales
const PORT = process.env.PORT || 3000;
const GAME_WIDTH = 800;
const GAME_HEIGHT = 400;

// Almacenar salas y jugadores
const rooms = new Map();
const players = new Map();

// Estructura de sala
class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = {};
        this.gameState = {
            ball: {
                x: GAME_WIDTH / 2,
                y: GAME_HEIGHT / 2,
                velX: 5,
                velY: 3,
                width: 10,
                height: 10,
                maxSpeed: 7
            },
            player1: {
                x: 20,
                y: GAME_HEIGHT / 2 - 50,
                score: 0
            },
            player2: {
                x: GAME_WIDTH - 35,
                y: GAME_HEIGHT / 2 - 50,
                score: 0
            }
        };
        this.isPlaying = false;
        this.gameSpeed = 1;
    }

    addPlayer(socketId, playerNumber, username) {
        this.players[socketId] = {
            socketId,
            playerNumber,
            username,
            inputs: { up: false, down: false }
        };
        return Object.keys(this.players).length;
    }

    removePlayer(socketId) {
        delete this.players[socketId];
        return Object.keys(this.players).length;
    }

    getPlayerCount() {
        return Object.keys(this.players).length;
    }

    updatePlayerInput(socketId, direction, pressed) {
        if (this.players[socketId]) {
            this.players[socketId].inputs[direction] = pressed;
        }
    }

    updateGameState() {
        if (!this.isPlaying) return;

        const ball = this.gameState.ball;
        const player1 = this.gameState.player1;
        const player2 = this.gameState.player2;
        const paddle = { width: 15, height: 100, speed: 6 };

        // Mover jugadores basado en inputs
        Object.values(this.players).forEach(player => {
            const playerState = player.playerNumber === 1 ? player1 : player2;
            if (player.inputs.up && playerState.y > 0) {
                playerState.y -= paddle.speed * this.gameSpeed;
            }
            if (player.inputs.down && playerState.y + paddle.height < GAME_HEIGHT) {
                playerState.y += paddle.speed * this.gameSpeed;
            }
            playerState.y = Math.max(0, Math.min(playerState.y, GAME_HEIGHT - paddle.height));
        });

        // Actualizar pelota
        ball.x += ball.velX * this.gameSpeed;
        ball.y += ball.velY * this.gameSpeed;

        // Colisión con bordes
        if (ball.y <= 0 || ball.y + ball.height >= GAME_HEIGHT) {
            ball.velY = -ball.velY;
            ball.y = Math.max(0, Math.min(ball.y, GAME_HEIGHT - ball.height));
        }

        // Colisión con raqueta 1
        if (
            ball.x <= player1.x + paddle.width &&
            ball.y + ball.height >= player1.y &&
            ball.y <= player1.y + paddle.height &&
            ball.velX < 0
        ) {
            ball.velX = -ball.velX;
            ball.x = player1.x + paddle.width;
            let collidePoint = ball.y - (player1.y + paddle.height / 2);
            collidePoint = collidePoint / (paddle.height / 2);
            ball.velY = collidePoint * ball.maxSpeed;
            ball.velX = Math.abs(ball.velX);
        }

        // Colisión con raqueta 2
        if (
            ball.x + ball.width >= player2.x &&
            ball.y + ball.height >= player2.y &&
            ball.y <= player2.y + paddle.height &&
            ball.velX > 0
        ) {
            ball.velX = -ball.velX;
            ball.x = player2.x - ball.width;
            let collidePoint = ball.y - (player2.y + paddle.height / 2);
            collidePoint = collidePoint / (paddle.height / 2);
            ball.velY = collidePoint * ball.maxSpeed;
            ball.velX = -Math.abs(ball.velX);
        }

        // Gol
        if (ball.x > GAME_WIDTH) {
            player1.score++;
            this.resetBall();
        }
        if (ball.x < 0) {
            player2.score++;
            this.resetBall();
        }

        // Verificar ganador
        if (player1.score >= 11 || player2.score >= 11) {
            this.isPlaying = false;
            return { gameOver: true, winner: player1.score >= 11 ? 1 : 2 };
        }

        return { gameOver: false };
    }

    resetBall() {
        this.gameState.ball.x = GAME_WIDTH / 2;
        this.gameState.ball.y = GAME_HEIGHT / 2;
        this.gameState.ball.velX = (Math.random() > 0.5 ? 1 : -1) * 5;
        this.gameState.ball.velY = (Math.random() - 0.5) * 5;
    }

    startGame() {
        this.isPlaying = true;
        this.resetBall();
        this.gameState.player1.score = 0;
        this.gameState.player2.score = 0;
    }
}

// ==================== RUTAS HTTP ====================
app.get('/', (req, res) => {
    res.json({ message: 'Servidor Pong Online activo', status: 'running' });
});

app.get('/api/rooms', (req, res) => {
    const roomsList = Array.from(rooms.values()).map(room => ({
        roomId: room.roomId,
        players: room.getPlayerCount(),
        isPlaying: room.isPlaying
    }));
    res.json(roomsList);
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date() });
});

// ==================== SOCKET.IO EVENTS ====================
io.on('connection', (socket) => {
    console.log(`Jugador conectado: ${socket.id}`);

    // Crear sala
    socket.on('create_room', (data) => {
        const roomId = `room_${Date.now()}`;
        const room = new GameRoom(roomId);
        const playerNumber = 1;
        
        room.addPlayer(socket.id, playerNumber, data.username || 'Anónimo');
        rooms.set(roomId, room);
        players.set(socket.id, { roomId, playerNumber });

        socket.join(roomId);
        socket.emit('room_created', {
            roomId,
            playerNumber,
            message: `Sala creada. Esperando jugador 2...`
        });

        console.log(`Sala creada: ${roomId}`);
    });

    // Unirse a sala
    socket.on('join_room', (data) => {
        const { roomId } = data;
        const room = rooms.get(roomId);

        if (!room) {
            socket.emit('error', { message: 'Sala no encontrada' });
            return;
        }

        if (room.getPlayerCount() >= 2) {
            socket.emit('error', { message: 'Sala llena' });
            return;
        }

        const playerNumber = 2;
        room.addPlayer(socket.id, playerNumber, data.username || 'Anónimo');
        players.set(socket.id, { roomId, playerNumber });

        socket.join(roomId);
        socket.emit('room_joined', {
            roomId,
            playerNumber,
            message: `Te uniste a la sala. ¡La partida comienza!`
        });

        // Notificar al otro jugador
        io.to(roomId).emit('player_joined', {
            player1: room.players[Object.keys(room.players)[0]]?.username,
            player2: room.players[Object.keys(room.players)[1]]?.username,
            canStart: room.getPlayerCount() === 2
        });

        console.log(`Jugador ${socket.id} se unió a la sala ${roomId}`);
    });

    // Iniciar juego
    socket.on('start_game', () => {
        const playerData = players.get(socket.id);
        if (!playerData) return;

        const room = rooms.get(playerData.roomId);
        if (!room) return;

        room.startGame();
        io.to(playerData.roomId).emit('game_started', {
            message: '¡Juego iniciado!',
            gameState: room.gameState
        });

        startGameLoop(playerData.roomId);
    });

    // Recibir input del jugador
    socket.on('player_input', (data) => {
        const playerData = players.get(socket.id);
        if (!playerData) return;

        const room = rooms.get(playerData.roomId);
        if (!room) return;

        room.updatePlayerInput(socket.id, data.direction, data.pressed);
    });

    // Desconectar
    socket.on('disconnect', () => {
        const playerData = players.get(socket.id);
        if (playerData) {
            const room = rooms.get(playerData.roomId);
            if (room) {
                const remainingPlayers = room.removePlayer(socket.id);
                if (remainingPlayers === 0) {
                    rooms.delete(playerData.roomId);
                    console.log(`Sala ${playerData.roomId} eliminada`);
                } else {
                    io.to(playerData.roomId).emit('player_disconnected', {
                        message: 'El otro jugador se desconectó'
                    });
                }
            }
            players.delete(socket.id);
        }
        console.log(`Jugador desconectado: ${socket.id}`);
    });

    // Chat básico
    socket.on('chat_message', (data) => {
        const playerData = players.get(socket.id);
        if (playerData) {
            io.to(playerData.roomId).emit('chat_message', {
                username: data.username,
                message: data.message,
                timestamp: new Date()
            });
        }
    });
});

// ==================== GAME LOOP ====================
const gameLoops = new Set();

function startGameLoop(roomId) {
    if (gameLoops.has(roomId)) return;
    
    gameLoops.add(roomId);

    const interval = setInterval(() => {
        const room = rooms.get(roomId);
        if (!room || !room.isPlaying) {
            clearInterval(interval);
            gameLoops.delete(roomId);
            return;
        }

        const result = room.updateGameState();
        io.to(roomId).emit('game_state_update', {
            gameState: room.gameState,
            gameOver: result.gameOver,
            winner: result.winner
        });

        if (result.gameOver) {
            io.to(roomId).emit('game_ended', {
                winner: result.winner,
                scores: {
                    player1: room.gameState.player1.score,
                    player2: room.gameState.player2.score
                }
            });
            clearInterval(interval);
            gameLoops.delete(roomId);
        }
    }, 1000 / 60); // 60 FPS
}

// ==================== INICIAR SERVIDOR ====================
server.listen(PORT, () => {
    console.log(`🎮 Servidor Pong Online escuchando en puerto ${PORT}`);
    console.log(`Accede a http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM recibido. Cerrando servidor...');
    server.close(() => {
        console.log('Servidor cerrado');
        process.exit(0);
    });
});
