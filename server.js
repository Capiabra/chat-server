const admin = require('firebase-admin');
const http = require('http'); // Добавляем модуль для создания сервера

// 1. ПОДКЛЮЧЕНИЕ FIREBASE
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const messaging = admin.messaging();

// 2. ФЕЙКОВЫЙ СЕРВЕР ДЛЯ RENDER.COM
// Render требует, чтобы Web Service слушал порт. Иначе он убьет приложение.
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Push Server is Running!');
});
// Render автоматически дает порт в переменной process.env.PORT
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Fake server listening on port ${PORT} to keep Render happy.`);
});

// 3. ОСНОВНАЯ ЛОГИКА
console.log("Firestore Listener started...");

const now = admin.firestore.Timestamp.now();

db.collectionGroup('messages')
  .where('createdAt', '>', now)
  .onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === 'added') {
        const msg = change.doc.data();
        // Защита от старых сообщений при рестарте (иногда бывает)
        if (msg.createdAt && msg.createdAt.toMillis() < Date.now() - 60000) return;

        const chatId = change.doc.ref.parent.parent.id; 

        console.log(`🔔 Event: New message in chat ${chatId} from ${msg.displayName}`);

        try {
            // А. Получаем участников чата
            const chatDoc = await db.collection('chats').doc(chatId).get();
            if (!chatDoc.exists) {
                console.log(`Chat ${chatId} not found.`);
                return;
            }
            const chatData = chatDoc.data();
            console.log(`Participants: ${JSON.stringify(chatData.participants)}`);

            // Б. Собираем токены
            const tokensToSend = [];
            
            for (const uid of chatData.participants) {
                // Пропускаем отправителя (не шлем пуш самому себе)
                if (uid === msg.uid) {
                    console.log(`Skipping sender: ${uid}`);
                    continue; 
                }

                // Ищем токен получателя
                const userDoc = await db.collection('active_users').doc(uid).get();
                if (userDoc.exists) {
                    const userData = userDoc.data();
                    if (userData.fcmToken) {
                        console.log(`Found token for user ${userData.name}: ${userData.fcmToken.substring(0, 10)}...`);
                        tokensToSend.push(userData.fcmToken);
                    } else {
                        console.log(`User ${userData.name || uid} has NO fcmToken.`);
                    }
                } else {
                    console.log(`User ${uid} not found in active_users.`);
                }
            }

            if (tokensToSend.length === 0) {
                console.log("⚠️ No tokens found to send. Aborting.");
                return;
            }

            // В. Отправляем пуш
            const payload = {
              notification: {
                title: msg.displayName || "New Message",
                body: "Send a message", 
              }
            };

            const response = await messaging.sendToDevice(tokensToSend, payload);
            console.log(`✅ Success: Sent ${response.successCount} messages.`);
            if (response.failureCount > 0) {
                console.log(`❌ Failed: ${response.failureCount}. Error: ${JSON.stringify(response.results)}`);
            }

        } catch (error) {
            console.error("🔥 Error in logic:", error);
        }
      }
    });
  });