require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { AudioMixer } = require('./mixer/audio-mixer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware yapılandırması
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Kök yolu için client.html'e yönlendirme
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Ses dosyalarının yüklenmesi için yapılandırma
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

// Sadece .wav dosyalarını kabul ediyoruz
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'audio/wav') {
      return cb(new Error('Sadece WAV formatı desteklenmektedir.'), false);
    }
    cb(null, true);
  }
});

// Dizinlerin varlığını kontrol et ve yoksa oluştur
const ensureDirectoryExists = (directory) => {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
};

ensureDirectoryExists('uploads');
ensureDirectoryExists('temp');

// Ses miksleme işlemcisini başlat
const audioMixer = new AudioMixer();
// Varsayılan ana ses kaynağını başlat
const backgroundAudioPath = process.env.BACKGROUND_AUDIO || path.join(__dirname, 'uploads', 'ambiance.wav');

// WebSocket istemci bağlantıları
const clients = new Set();

// Ses akışını başlat
audioMixer.startMixing(backgroundAudioPath, (mixedBuffer) => {
  // Tüm bağlı istemcilere ses verisini gönder
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(mixedBuffer);
    }
  });
});

// WebSocket bağlantıları
wss.on('connection', (ws) => {
  console.log('Yeni istemci bağlandı');
  clients.add(ws);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'playSound') {
        // Belirli bir ses dosyasını çal
        console.log('Ses çalma isteği:', data.soundPath);
        audioMixer.addAudioToMix(data.soundPath, data.volume || 1.0);
      }
    } catch (error) {
      console.error('WebSocket mesaj işleme hatası:', error);
    }
  });

  ws.on('close', () => {
    console.log('İstemci bağlantısı kesildi');
    clients.delete(ws);
  });
});

// API endpoint'leri
app.post('/api/upload-sound', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Dosya yüklenemedi' });
  }
  
  res.json({
    success: true,
    filePath: req.file.path,
    filename: req.file.filename
  });
});

app.post('/api/play-sound', (req, res) => {
  const { soundPath, volume } = req.body;
  
  if (!soundPath) {
    return res.status(400).json({ error: 'Ses dosya yolu belirtilmedi' });
  }
  
  try {
    audioMixer.addAudioToMix(soundPath, volume || 1.0);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Kullanılabilir ses dosyalarını listeleme endpoint'i
app.get('/api/available-sounds', (req, res) => {
  try {
    const uploadsDir = path.join(__dirname, 'uploads');
    
    // uploads klasöründeki tüm .wav dosyalarını bul
    const files = fs.readdirSync(uploadsDir)
      .filter(file => file.endsWith('.wav'))
      .map(file => ({
        name: file.replace('.wav', ''),
        path: 'uploads/' + file
      }));
    
    res.json({ sounds: files });
  } catch (error) {
    console.error('Ses dosyalarını listeleme hatası:', error);
    res.status(500).json({ error: 'Ses dosyaları listelenirken bir hata oluştu' });
  }
});

// Sunucuyu başlat
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor`);
});