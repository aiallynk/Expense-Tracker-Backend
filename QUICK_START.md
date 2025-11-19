# Quick Start Guide - Backend Server

## 🚀 Start the Server

### Option 1: Development Mode (Recommended for testing)
```bash
cd BACKEND
npm run dev
```

### Option 2: Production Mode
```bash
cd BACKEND
npm run build
npm start
```

## ✅ Check if Server is Running

After starting the server, you should see:
```
✅ Server running on port 4000
Environment: development
API available at http://localhost:4000/api/v1
For Android emulator, use: http://10.0.2.2:4000/api/v1
For physical devices, use one of these IPs:
  http://192.168.31.166:4000/api/v1
```

## 🔍 Test Server Connection

### Method 1: Use the check script
```bash
cd BACKEND
node check-server.js
```

### Method 2: Open in browser
Open: `http://localhost:4000/health`

You should see:
```json
{
  "success": true,
  "message": "Server is healthy",
  "timestamp": "...",
  "database": {
    "connected": true/false,
    "status": "connected" or "disconnected"
  }
}
```

## ⚠️ MongoDB Connection

The server will start even if MongoDB is not connected, but **login/signup will not work** without MongoDB.

### To fix MongoDB connection:

1. **If using local MongoDB:**
   - Make sure MongoDB is installed and running
   - Default connection: `mongodb://localhost:27017`

2. **If using MongoDB Atlas (Cloud):**
   - Get your connection string from MongoDB Atlas
   - Add it to `.env` file: `MONGODB_URI=mongodb+srv://...`

3. **Create `.env` file:**
   ```bash
   cd BACKEND
   cp env.example .env
   ```
   Then edit `.env` and set:
   ```
   MONGODB_URI=mongodb://localhost:27017
   MONGODB_DB_NAME=expense_tracker
   ```

## 📱 Connect from Flutter App

1. Make sure server is running
2. Check the IP address shown in server logs
3. Update `travel_expense_app/lib/services/api_service.dart` line 24 if needed:
   ```dart
   static const String? _manualComputerIp = '192.168.31.166'; // Your IP
   ```

## 🐛 Troubleshooting

### Server won't start
- Check if port 4000 is already in use
- Check terminal for error messages
- Make sure you're in the BACKEND directory

### Can't connect from app
- Verify server is running (check terminal)
- Check IP address matches in both server logs and app config
- Ensure device and computer are on same Wi-Fi network
- Check Windows Firewall allows port 4000

### Login/Signup fails
- Check MongoDB connection status in `/health` endpoint
- Verify `.env` file has correct MongoDB URI
- Check server logs for error messages

