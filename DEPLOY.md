# 🚀 Deployment Guide

## Camera Fix
✅ Changed canvas from `object-cover` to `object-contain` - no more stretching!

## Deployment Options

### ⭐ OPTION 1: Railway (RECOMMENDED - 5 minutes)

Railway is FREE and supports WebSockets perfectly!

**Steps:**

1. **Push to GitHub:**
   ```bash
   cd /Users/slava/dev/goonyclicker
   git init
   git add .
   git commit -m "Initial commit"
   gh repo create goonyclicker --public --source=. --push
   ```

2. **Deploy to Railway:**
   - Go to https://railway.app
   - Click "Start a New Project"
   - Choose "Deploy from GitHub repo"
   - Select your `goonyclicker` repo
   - Railway will auto-detect Next.js and deploy!
   - You'll get a public HTTPS URL like: `https://goonyclicker.up.railway.app`

**That's it!** Your app will be live with HTTPS and work on mobile!

---

### OPTION 2: Render.com (Also Free)

1. Push code to GitHub (same as above)
2. Go to https://render.com
3. Create new "Web Service"
4. Connect GitHub repo
5. Build command: `npm run build`
6. Start command: `npm start`
7. Deploy!

---

### ❌ Why NOT Vercel?

Vercel doesn't support WebSocket servers (Socket.io). Your multiplayer
features would break. Use Railway or Render instead!

---

## Local Development

```bash
npm run dev
# Access at http://localhost:3000
```

## Testing on Mobile (Local Network)

```bash
# Your LAN IP: http://10.243.161.121:3000
# OR use ngrok: ngrok http 3000
```

