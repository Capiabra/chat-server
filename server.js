const admin = require('firebase-admin');

// Мы будем передавать ключи через "Переменные окружения" на Render, чтобы не светить файл
// Но для локального теста можешь вставить сюда содержимое JSON файла
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const messaging = admin.messaging();

console.log("Server started! Listening for new messages...");

// Слушаем ВСЕ под-коллекции 'messages' во всей базе
// .where проверяет, что сообщение новое (создано после запуска сервера)
const now = admin.firestore.Timestamp.now();

db.collectionGroup('messages')
  .where('createdAt', '>', now)
  .onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      if (change.type === 'added') {
        const msg = change.doc.data();
        const chatId = change.doc.ref.parent.parent.id; // Получаем ID чата

        console.log(`New message in chat ${chatId} from ${msg.displayName}`);

        // 1. Получаем инфо о чате, чтобы узнать участников
        const chatDoc = await db.collection('chats').doc(chatId).get();
        if (!chatDoc.exists) return;
        const chatData = chatDoc.data();

        // 2. Ищем токены получателей
        const tokensToSend = [];
        
        // Проходим по всем участникам
        for (const uid of chatData.participants) {
            if (uid === msg.uid) continue; // Не шлем самому себе

            // Берем токен из active_users
            const userDoc = await db.collection('active_users').doc(uid).get();
            if (userDoc.exists && userDoc.data().fcmToken) {
                tokensToSend.push(userDoc.data().fcmToken);
            }
        }

        if (tokensToSend.length === 0) return;

        // 3. Отправляем пуш
        // Текст зашифрован, поэтому пишем общее сообщение
        const payload = {
          notification: {
            title: msg.displayName,
            body: "New Message 🔒", 
          }
        };

        messaging.sendToDevice(tokensToSend, payload)
          .then(response => {
            console.log('Successfully sent message:', response.successCount);
          })
          .catch(error => {
            console.log('Error sending message:', error);
          });
      }
    });
  });