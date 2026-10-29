'use strict';

const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

class Thumbnails {
  constructor(userDataPath) {
    this.dir = path.join(userDataPath, 'thumbnails');
    this.cache = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
  }

  fileFor(id) {
    return path.join(this.dir, id + '.jpg');
  }

  save(id, image) {
    try {
      if (!image || image.isEmpty()) return false;
      const resized = image.resize({ width: 480, quality: 'good' });
      const jpeg = resized.toJPEG(74);
      if (!jpeg || jpeg.length < 1200) return false;
      fs.writeFileSync(this.fileFor(id), jpeg);
      this.cache.delete(id);
      return true;
    } catch {
      return false;
    }
  }

  saveBuffer(id, buffer) {
    try {
      if (!buffer || !buffer.length) return false;
      const image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) return false;
      return this.save(id, image);
    } catch {
      return false;
    }
  }

  has(id) {
    try { return fs.statSync(this.fileFor(id)).size > 1200; } catch { return false; }
  }

  preview(id) {
    try {
      const file = this.fileFor(id);
      const stat = fs.statSync(file);
      const cached = this.cache.get(id);
      if (cached && cached.mtime === stat.mtimeMs) return cached.data;
      const b64 = fs.readFileSync(file).toString('base64');
      const data = `data:image/jpeg;base64,${b64}`;
      this.cache.set(id, { mtime: stat.mtimeMs, data });
      return data;
    } catch {
      return '';
    }
  }

  remove(id) {
    this.cache.delete(id);
    try { fs.unlinkSync(this.fileFor(id)); } catch {}
  }
}

module.exports = { Thumbnails };
