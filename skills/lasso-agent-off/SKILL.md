---
name: lasso-agent-off
description: Mematikan server Lasso Agent (localhost:8080). Trigger dengan /lasso-agent-off.
---

# Lasso Agent Off Skill

Mematikan server lokal Lasso Agent yang sedang berjalan di background (port 8080).

## MANDATORY AGENT BEHAVIOR WHEN /lasso-agent-off IS TRIGGERED:

1. **Jalankan Perintah Stop:**
   Eksekusi perintah stop di background:
   ```bash
   /data/data/com.termux/files/home/.gemini/config/skills/lasso-agent/scripts/lasso-ctl.sh stop
   ```

2. **Berikan Laporan ke Pengguna:**
   - Jika output mengandung `STOPPED`:
     > 🛑 **Server Lasso Agent (http://127.0.0.1:8080) telah berhasil dimatikan.**  
     > Port 8080 kini bebas. Ketik `/lasso-agent` kapan saja untuk menyalakannya kembali.
   - Jika output mengandung `NOT_RUNNING`:
     > ℹ️ **Server Lasso Agent saat ini tidak sedang berjalan.**  
     > Ketik `/lasso-agent` untuk menjalankan project saat ini di localhost.
