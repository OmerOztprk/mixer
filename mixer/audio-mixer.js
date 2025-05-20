const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

class AudioMixer {
  constructor() {
    this.activeSources = new Map();
    this.backgroundAudio = null;
    this.isRunning = false;
    this.mixingInterval = null;
    this.sampleRate = 44100;
    this.channels = 2;
    this.bufferSize = 4096; // Buffer boyutu
    this.mixCallback = null;
  }

  // Ana miksleme döngüsünü başlat
  startMixing(backgroundAudioPath, callback) {
    if (this.isRunning) {
      console.warn('Miksleme işlemi zaten çalışıyor');
      return;
    }

    this.mixCallback = callback;
    this.isRunning = true;

    try {
      // Arkaplan ses dosyasını PCM formatına dönüştür ve sürekli çal
      this.loadBackgroundAudio(backgroundAudioPath);
      
      // Ses miksleme döngüsünü başlat
      this.startMixingLoop();
      
      console.log('Ses miksleme işlemi başlatıldı');
    } catch (error) {
      console.error('Miksleme başlatma hatası:', error);
      this.isRunning = false;
    }
  }

  // Arkaplan ses dosyasını yükle
  loadBackgroundAudio(filePath) {
    if (!fs.existsSync(filePath)) {
      console.warn(`Arkaplan ses dosyası bulunamadı: ${filePath}. Boş ses kullanılacak.`);
      
      // Boş ses buffer'ı oluştur
      const silentBuffer = this.createSilentBuffer(this.sampleRate * 5); // 5 saniye sessizlik
      this.backgroundAudio = {
        buffer: [silentBuffer, silentBuffer], // Stereo için aynı buffer'ı iki kere kullan
        position: 0,
        looping: true
      };
      return;
    }

    try {
      // FFmpeg ile WAV dosyasını doğrudan PCM'e dönüştür
      const pcmData = this.convertToPcmUsingFFmpeg(filePath);
      
      console.log('Arkaplan sesi yüklendi:', path.basename(filePath));
      
      this.backgroundAudio = {
        buffer: pcmData,
        position: 0,
        looping: true
      };
    } catch (error) {
      console.error('Arkaplan ses yükleme hatası:', error);
      
      // Hata durumunda boş ses buffer'ı oluştur
      const silentBuffer = this.createSilentBuffer(this.sampleRate * 5);
      this.backgroundAudio = {
        buffer: [silentBuffer, silentBuffer],
        position: 0,
        looping: true
      };
    }
  }

  // FFmpeg kullanarak PCM'e dönüştür
  convertToPcmUsingFFmpeg(filePath) {
    const tempDir = path.join(__dirname, '../temp');
    
    // Temp dizini yoksa oluştur
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    const outputFilename = path.join(tempDir, `${Date.now()}_pcm_data.raw`);
    
    try {
      // FFmpeg ile senkron dönüşüm
      const ffmpegCmd = `ffmpeg -i "${filePath}" -f f32le -acodec pcm_f32le -ar ${this.sampleRate} -ac ${this.channels} "${outputFilename}"`;
      require('child_process').execSync(ffmpegCmd);
      
      // Oluşturulan PCM dosyasını oku
      const rawData = fs.readFileSync(outputFilename);
      
      // Float32 buffer'a dönüştür
      const floatBuffer = new Float32Array(rawData.buffer, rawData.byteOffset, rawData.byteLength / 4);
      
      // Kanalları ayır
      const channelData = [];
      for (let c = 0; c < this.channels; c++) {
        const channelBuffer = new Float32Array(floatBuffer.length / this.channels);
        for (let i = 0; i < channelBuffer.length; i++) {
          channelBuffer[i] = floatBuffer[i * this.channels + c];
        }
        channelData.push(channelBuffer);
      }
      
      // Temp dosyasını temizle
      fs.unlinkSync(outputFilename);
      
      return channelData;
    } catch (error) {
      console.error('FFmpeg dönüştürme hatası:', error);
      
      // Hata durumunda boş PCM verisi döndür
      const emptyBuffer = this.createSilentBuffer(this.sampleRate * 2); // 2 saniyelik sessizlik
      return [emptyBuffer, emptyBuffer]; // Stereo
    }
  }

  // Sessiz buffer oluştur
  createSilentBuffer(length) {
    return new Float32Array(length).fill(0);
  }

  // Karıştırma döngüsünü başlat
  startMixingLoop() {
    const bufferTime = (this.bufferSize / this.sampleRate) * 1000;
    
    this.mixingInterval = setInterval(() => {
      if (!this.isRunning) return;
      
      const mixedBuffer = this.mixAudioChunk();
      
      if (this.mixCallback) {
        this.mixCallback(mixedBuffer);
      }
    }, bufferTime / 2);
  }

  // Ses dosyasını karışıma ekle
  addAudioToMix(filePath, volume = 1.0) {
    try {
      const sourcePath = path.resolve(filePath);
      
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Ses dosyası bulunamadı: ${sourcePath}`);
      }

      console.log(`Ses dosyası karışıma eklendi: ${path.basename(sourcePath)}`);
      
      // FFmpeg ile PCM'e dönüştür
      const pcmData = this.convertToPcmUsingFFmpeg(sourcePath);
      
      const sourceId = Date.now().toString();
      this.activeSources.set(sourceId, {
        buffer: pcmData,
        position: 0,
        volume: Math.max(0, Math.min(1, volume)),
        completed: false
      });
      
      console.log(`Ses ID: ${sourceId}`);
      
      return sourceId;
    } catch (error) {
      console.error('Ses ekleme hatası:', error);
      throw error;
    }
  }

  // Ses parçalarını miksledikten sonra PCM buffer'ı döndür
  mixAudioChunk() {
    const mixedChannels = Array(this.channels).fill().map(() => 
      new Float32Array(this.bufferSize).fill(0)
    );
    
    if (this.backgroundAudio) {
      this.mixSourceIntoBuffer(this.backgroundAudio, mixedChannels);
    }
    
    for (const [sourceId, source] of this.activeSources.entries()) {
      this.mixSourceIntoBuffer(source, mixedChannels);
      
      if (source.completed) {
        this.activeSources.delete(sourceId);
      }
    }
    
    const interleavedBuffer = this.interleaveChannels(mixedChannels);
    const pcmBuffer = this.floatTo16BitPCM(interleavedBuffer);
    
    return pcmBuffer;
  }

  // Bir ses kaynağını ana buffer'a karıştır
  mixSourceIntoBuffer(source, mixedChannels) {
    const sourceChannels = source.buffer;
    const volume = source.volume || 1.0;
    
    for (let c = 0; c < Math.min(sourceChannels.length, mixedChannels.length); c++) {
      const sourceChannel = sourceChannels[c];
      const mixChannel = mixedChannels[c];
      
      for (let i = 0; i < this.bufferSize; i++) {
        if (source.position + i < sourceChannel.length) {
          mixChannel[i] += sourceChannel[source.position + i] * volume;
        }
      }
    }
    
    source.position += this.bufferSize;
    
    if (source.position >= sourceChannels[0].length) {
      if (source.looping) {
        source.position = 0;
      } else {
        source.completed = true;
      }
    }
  }

  // Kanalları birleştir
  interleaveChannels(channels) {
    const numChannels = channels.length;
    const length = channels[0].length;
    const interleaved = new Float32Array(length * numChannels);
    
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < numChannels; c++) {
        interleaved[i * numChannels + c] = channels[c][i];
      }
    }
    
    return interleaved;
  }

  // Float PCM'i 16-bit PCM'e dönüştür
  floatTo16BitPCM(floatBuffer) {
    const pcmBuffer = Buffer.alloc(floatBuffer.length * 2);
    
    for (let i = 0; i < floatBuffer.length; i++) {
      let value = Math.floor(floatBuffer[i] * 32767);
      value = Math.max(-32768, Math.min(32767, value));
      pcmBuffer.writeInt16LE(value, i * 2);
    }
    
    return pcmBuffer;
  }

  // Miksleme işlemini durdur
  stopMixing() {
    if (this.mixingInterval) {
      clearInterval(this.mixingInterval);
      this.mixingInterval = null;
    }
    
    this.isRunning = false;
    this.activeSources.clear();
    console.log('Ses miksleme işlemi durduruldu');
  }
}

module.exports = { AudioMixer };