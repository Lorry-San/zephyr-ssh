# 🌬️ Zephyr-SSH

> A WebSSH client with smooth text selection and copy experience, just like selecting text on a normal webpage.

## ✨ Features

- 🌊 **Smooth Copy** – Based on wterm DOM rendering, terminal text can be selected and copied like a regular webpage
- 📱 **Mobile Optimized** – Support long press and drag selection with native system copy menu
- 🔐 **Full SSH Support** – Password/private key authentication, custom port, initial command
- 🐳 **One-click Deploy** – Docker image, ready to use

## 🚀 Quick Start

### Run with Docker

```bash
docker pull ghcr.io/lanlan13-14/zephyr-ssh:latest

docker run -d \
  --name zephyr-ssh \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/lanlan13-14/zephyr-ssh:latest
```

Access

Open your browser and visit: http://your-server-ip:3000

📱 Usage

1. Fill in your server information (host, port, username, password or private key)
2. Click 「Connect SSH」
3. In the terminal, long press or drag to select text – just like on a normal webpage

🔧 Environment Variables

Variable Description Default
PORT Server port 3000

📦 Image

```
ghcr.io/lanlan13-14/zephyr-ssh:latest
```

🛠️ Local Development

```bash
# Install dependencies
npm install

# Start server
npm start

# Visit
open http://localhost:3000
```

📂 Project Structure

```
zephyr-ssh/
├── public/           # Frontend pages
│   ├── index.html    # Login page
│   ├── terminal.html # Terminal page
│   ├── style.css     # Styles
│   ├── client.js     # Login logic
│   └── terminal.js   # Terminal core
├── server.js         # Backend service
├── package.json      # Dependencies
├── Dockerfile        # Image build
└── README.md         # Documentation
```

💡 Notes

· Terminal text can be selected by drag and drop – no extra steps required
· Supports both password and private key authentication
· Private key supports PEM format (-----BEGIN RSA PRIVATE KEY-----)

## 🙏 Acknowledgements

- 🖥️ [wterm](https://github.com/vercel-labs/wterm)
- 🔐 [ssh2](https://github.com/mscdex/ssh2)
