---
name: lasso-agent
description: Visual AI Code Editor & In-App Overlay powered by Antigravity. Menjalankan project/game saat ini di 127.0.0.1:8080 dengan overlay Lasso visual editing yang terhubung langsung ke sesi Antigravity aktif. Trigger dengan /lasso-agent.
---

# Lasso Agent Skill

Lasso Agent menjalankan project atau aplikasi web Anda (misal game HTML, web app, atau frontend di direktori saat ini) pada localhost (`127.0.0.1:8080`), menginjeksi overlay visual Lasso langsung di atas aplikasi yang sedang berjalan, dan menghubungkannya ke sesi **Google Antigravity** aktif.

## MANDATORY AGENT BEHAVIOR WHEN /lasso-agent IS TRIGGERED:

1. **Dapatkan Direktori Proyek Saat Ini:**
   - Gunakan direktori aktif saat ini (`$(pwd)`, misal `~/game` atau folder proyek user).

2. **Periksa Status Server Saat Ini:**
   Jalankan perintah berikut di background:
   ```bash
   /data/data/com.termux/files/home/.gemini/config/skills/lasso-agent/scripts/lasso-ctl.sh status
   ```

3. **Jika Server Belum Berjalan (`STOPPED`) atau Berjalan di Folder Lain:**
   - Jalankan server untuk melayani proyek di direktori saat ini:
     ```bash
     /data/data/com.termux/files/home/.gemini/config/skills/lasso-agent/scripts/lasso-ctl.sh stop
     /data/data/com.termux/files/home/.gemini/config/skills/lasso-agent/scripts/lasso-ctl.sh start "$(pwd)"
     ```
   - Ambil port yang dilaporkan (biasanya `8080`).
   - Berikan respon yang informatif kepada pengguna:
     - Tampilkan status aktif: `🚀 Project Anda berhasil dijalankan dengan Lasso Agent!`
     - Berikan link clickable: `http://127.0.0.1:8080` (atau port aktif yang dilaporkan).
     - Informasikan bahwa aplikasi/game Anda sedang berjalan dengan overlay visual Lasso yang terhubung langsung ke sesi Antigravity ini (`ANTIGRAVITY_CONVERSATION_ID`).
     - Cara pakai di browser:
       - 🎮 **Mainkan / Gunakan Aplikasi**: Aplikasi/game Anda berjalan normal di browser.
       - 🎯 **Visual Selection & Toolbar**: Klik elemen atau tombol di dalam aplikasi/game untuk langsung meminta AI mengubahnya.
       - ⚡ **Command Bar (⌘K / Ctrl+K)**: Tekan shortcut untuk membuka prompt bar AI langsung di atas layar game/aplikasi.
       - 🔍 **Live Diff Review**: Setelah AI melakukan perbaikan kode, tombol **Accept** akan mereload game secara otomatis dengan kode baru.

4. **Jika Server Sudah Berjalan di Direktori yang Sama:**
   - Tampilkan informasi bahwa Lasso Agent sudah aktif di `http://127.0.0.1:<port>`.
   - Gunakan tool `ask_question` untuk memberi pilihan cepat kepada user:
     - `question`: "Lasso Agent saat ini aktif di port <port>. Apa yang ingin Anda lakukan?"
     - `options`:
       - `1. Buka / Tetap Jalankan Aplikasi (http://127.0.0.1:<port>)`
       - `2. Restart Server Lasso Agent di folder ini`
       - `3. Hentikan (Stop) Server Lasso Agent`
     - `is_multi_select`: `false`
   - Setelah user memilih:
     - Jika pilihan **1**: Konfirmasi link `http://127.0.0.1:<port>`.
     - Jika pilihan **2**: Jalankan `lasso-ctl.sh stop && lasso-ctl.sh start "$(pwd)"` dan laporkan port baru.
     - Jika pilihan **3**: Jalankan `lasso-ctl.sh stop` dan laporkan bahwa server telah dihentikan.
