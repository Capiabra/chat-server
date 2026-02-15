const admin = require('firebase-admin');
const http = require('http');

// 1. ПОДКЛЮЧЕНИЕ FIREBASE
// Получаем ключи из переменных окружения Render
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
    console.error("CRITICAL ERROR: Could not parse FIREBASE_SERVICE_ACCOUNT. Check Render Environment Variables.");
    process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const messaging = admin.messaging();

// 2. ФЕЙКОВЫЙ СЕРВЕР ДЛЯ RENDER.COM
// Это нужно, чтобы Render не убивал процесс (он требует открытый порт)
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Push Server is Running! (v2.0 - HTTP v1 API)');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Fake server listening on port ${PORT} to keep Render happy.`);
});

// 3. ОСНОВНАЯ ЛОГИКА
console.log("Firestore Listener started...");

// Берем время "сейчас минус 1 минута", чтобы при перезагрузке сервера
// не потерять сообщения, отправленные в момент рестарта.
const startTimestamp = admin.firestore.Timestamp.fromMillis(Date.now() - 60000);

db.collectionGroup('messages')
  .where('createdAt', '>', startTimestamp)
  .onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === 'added') {
        const msg = change.doc.data();
        
        // Дополнительная защита от обработки старых сообщений (если сервер долго спал)
        // Игнорируем сообщения старше 2 минут
        if (msg.createdAt && msg.createdAt.toMillis() < Date.now() - 120000) {
            return;
        }

        const chatId = change.doc.ref.parent.parent.id; 

        console.log(`🔔 Event: New message in chat ${chatId} from ${msg.displayName}`);

        try {
            // А. Получаем список участников чата
            const chatDoc = await db.collection('chats').doc(chatId).get();
            if (!chatDoc.exists) {
                console.log(`Chat ${chatId} not found.`);
                return;
            }
            const chatData = chatDoc.data();

            // Б. Собираем токены получателей
            const tokensToSend = [];
            
            for (const uid of chatData.participants) {
                // Пропускаем отправителя (не шлем пуш самому себе)
                if (uid === msg.uid) {
                    continue; 
                }

                // Ищем токен получателя в базе
                const userDoc = await db.collection('active_users').doc(uid).get();
                if (userDoc.exists) {
                    const userData = userDoc.data();
                    if (userData.fcmToken) {
                        console.log(`Found token for user ${userData.name}: ${userData.fcmToken.substring(0, 10)}...`);
                        tokensToSend.push(userData.fcmToken);
                    } else {
                        console.log(`User ${userData.name || uid} has NO fcmToken (Not logged in or blocked notifications).`);
                    }
                }
            }

            if (tokensToSend.length === 0) {
                console.log("⚠️ No valid tokens found. No push sent.");
                return;
            }

            // В. Отправляем пуш (НОВЫЙ API - HTTP v1)
            // Используем sendEachForMulticast вместо устаревшего sendToDevice
            const message = {
                notification: {
                    title: msg.displayName || "New Message",
                    body: "Sent a message" // Текст зашифрован, пишем общее
                },
                tokens: tokensToSend // Массив токенов
            };

            const response = await messaging.sendEachForMulticast(message);
            
            console.log(`✅ Success: Sent ${response.successCount} messages.`);
            
            if (response.failureCount > 0) {
                console.log('Failed transmissions details:');
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        // Выводим код ошибки (например, token-not-registered)
                        console.log(`- Token ending in ...${tokensToSend[idx].slice(-5)}: ${resp.error.code} - ${resp.error.message}`);
                    }
                });
            }

        } catch (error) {
            console.error("🔥 Error in logic:", error);
        }
      }
    });
  });