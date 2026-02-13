const { createServer } = require('http');
const { Server } = require('socket.io');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0'; // Listen on all network interfaces
const port = 3000;

const app = next({ dev, hostname: 'localhost', port });
const handler = app.getRequestHandler();

const rooms = new Map();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    // Add debug endpoint to check active rooms
    if (req.url === '/api/rooms') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        rooms: Array.from(rooms.entries()).map(([code, room]) => ({
          code,
          players: room.players.map(p => ({ id: p.id, name: p.name })),
          gameStarted: room.gameStarted
        }))
      }));
      return;
    }
    handler(req, res);
  });
  
  const io = new Server(httpServer, {
    transports: ['polling', 'websocket'], // Use polling for Vercel compatibility
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    console.log('Active rooms:', Array.from(rooms.keys()));

    socket.on('create-room', ({ playerName, timeLimit }) => {
      const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      rooms.set(roomCode, {
        players: [{ id: socket.id, name: playerName, score: 0, position: 0, multiplier: 1, currency: 0 }],
        gameStarted: false,
        timeLimit: timeLimit || 120,
      });
      socket.join(roomCode);
      socket.emit('room-created', { roomCode, playerId: socket.id });
      console.log(`Room created: ${roomCode} by ${playerName} with time limit ${timeLimit}s`);
      console.log('All rooms:', Array.from(rooms.keys()));
    });

    socket.on('join-room', ({ roomCode, playerName }) => {
      console.log(`Attempting to join room: ${roomCode} by ${playerName}`);
      console.log('Available rooms:', Array.from(rooms.keys()));
      
      const room = rooms.get(roomCode);
      if (!room) {
        console.log(`Room ${roomCode} not found!`);
        socket.emit('error', 'Room not found');
        return;
      }
      if (room.players.length >= 2) {
        console.log(`Room ${roomCode} is full`);
        socket.emit('error', 'Room is full');
        return;
      }
      
      room.players.push({ id: socket.id, name: playerName, score: 0, position: 0, multiplier: 1, currency: 0 });
      socket.join(roomCode);
      
      console.log(`Player ${playerName} joined room ${roomCode}`);
      
      io.to(roomCode).emit('player-joined', {
        players: room.players,
        roomCode,
      });
      
      if (room.players.length === 2) {
        room.gameStarted = true;
        console.log(`Game starting in room ${roomCode} with ${room.timeLimit}s time limit`);
        io.to(roomCode).emit('game-start', { players: room.players, timeLimit: room.timeLimit });
      }
    });

    socket.on('game-over', ({ roomCode }) => {
      console.log(`Game over in room ${roomCode}`);
      const room = rooms.get(roomCode);
      if (!room) return;

      // Find winner (highest score)
      const winner = room.players.reduce((prev, current) => 
        (current.score > prev.score) ? current : prev
      );
      
      console.log(`Winner: ${winner.name} with ${winner.score} points`);
      io.to(roomCode).emit('game-over', { winner });
    });

    socket.on('update-score', ({ roomCode, score }) => {
      console.log(`Score update from ${socket.id} in room ${roomCode}: ${score}`);
      const room = rooms.get(roomCode);
      if (!room) {
        console.log(`Room ${roomCode} not found for score update`);
        return;
      }
      
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.score = score;
        console.log(`Updated player ${player.name} score to ${score}, broadcasting to room`);
        io.to(roomCode).emit('score-update', { players: room.players });
      } else {
        console.log(`Player ${socket.id} not found in room ${roomCode}`);
      }
    });

    socket.on('update-multiplier', ({ roomCode, multiplier }) => {
      console.log(`Multiplier update from ${socket.id} in room ${roomCode}: ${multiplier}`);
      const room = rooms.get(roomCode);
      if (!room) return;
      
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.multiplier = multiplier;
        console.log(`Updated player ${player.name} multiplier to ${multiplier}`);
        io.to(roomCode).emit('score-update', { players: room.players });
      }
    });

    // WebRTC signaling
    socket.on('webrtc-offer', ({ offer, roomCode }) => {
      console.log(`WebRTC offer from ${socket.id} in room ${roomCode}`);
      socket.to(roomCode).emit('webrtc-offer', { offer, from: socket.id });
    });

    socket.on('webrtc-answer', ({ answer, to }) => {
      console.log(`WebRTC answer from ${socket.id} to ${to}`);
      io.to(to).emit('webrtc-answer', { answer });
    });

    socket.on('webrtc-ice', ({ candidate, to, roomCode }) => {
      if (to) {
        io.to(to).emit('webrtc-ice', { candidate });
      } else if (roomCode) {
        socket.to(roomCode).emit('webrtc-ice', { candidate });
      }
    });

    socket.on('disconnect', () => {
      console.log('Player disconnected:', socket.id);
      
      // Clean up rooms
      for (const [roomCode, room] of rooms.entries()) {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
          rooms.delete(roomCode);
        } else {
          io.to(roomCode).emit('player-left', { players: room.players });
        }
      }
    });
  });

  httpServer.listen(port, hostname, () => {
    console.log(`> Ready on http://localhost:${port}`);
    console.log(`> LAN access: http://<YOUR_IP>:${port}`);
  });
});
