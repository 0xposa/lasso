---
name: lasso-agent
description: Visual AI Code Editor & Web Dashboard powered by Antigravity. Menjalankan local server di 127.0.0.1:8080 untuk visual editing dan command bar interaktif. Trigger dengan /lasso-agent.
---

# Lasso Agent Skill

Lasso Agent menghubungkan aplikasi web Anda dengan antarmuka visual editing dan command bar interaktif yang ditenagai langsung oleh **Google Antigravity**.

## MANDATORY AGENT BEHAVIOR WHEN /lasso-agent IS TRIGGERED:

1. **Periksa Status Server Saat Ini:**
   Jalankan perintah berikut di background:
   ```bash
   /data/data/com.termux/files/home/.gemini/config/skills/lasso-agent/scripts/lasso-ctl.sh status
   ```

2. **Jika Status `STOPPED` atau Belum Berjalan:**
   - Nyalakan server Lasso Agent dengan perintah:
     ```bash
     /data/data/com.termux/files/home/.gemini/config/skills/lasso-agent/scripts/lasso-ctl.sh start "$(pwd)"
     ```
   - Ambil port yang dilaporkan (biasanya `8080`).
   - Berikan respon yang informatif dan elegan kepada pengguna:
     - Tampilkan status aktif: `🚀 Lasso Agent berhasil dijalankan!`
     - Berikan link clickable: `http://127.0.0.1:8080` (atau port aktif yang dilaporkan).
     - Informasikan bahwa sesi ini terhubung langsung ke sesi Antigravity aktif dan mengingat konteks percakapan multi-turn.
     - Ringkasan fitur yang tersedia di Web UI:
       - 🎯 **Visual App Canvas & Preview**: Masukkan URL aplikasi lokal (misal `http://localhost:3000`).
       - ⚡ **Command Prompt (⌘K)**: Instruksikan AI untuk membuat fitur atau mengubah kode.
       - 🔍 **Live Diff Review**: Review perubahan kode sebelum di-*Accept* atau di-*Revert*.

3. **Jika Status `RUNNING:<port>` (Server Sudah Aktif):**
   - Tampilkan informasi bahwa Lasso Agent sudah aktif di `http://127.0.0.1:<port>`.
   - Gunakan tool `ask_question` untuk memberi pilihan cepat kepada user:
     - `question`: "Lasso Agent saat ini aktif di port <port>. Apa yang ingin Anda lakukan?"
     - `options`:
       - `1. Buka / Tetap Jalankan Dashboard (http://127.0.0.1:<port>)`
       - `2. Restart Server Lasso Agent`
       - `3. Hentikan (Stop) Server Lasso Agent`
     - `is_multi_select`: `false`
   - Setelah user memilih:
     - Jika pilihan **1**: Konfirmasi link `http://127.0.0.1:<port>`.
     - Jika pilihan **2**: Jalankan `lasso-ctl.sh stop && lasso-ctl.sh start "$(pwd)"` dan laporkan port baru.
     - Jika pilihan **3**: Jalankan `lasso-ctl.sh stop` dan laporkan bahwa server telah dihentikan.
