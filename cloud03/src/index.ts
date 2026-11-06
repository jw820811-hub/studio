import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { createApp } from './app.js';
import { StudioOAuth } from './auth.js';
import { RecordService } from './records.js';
import { FirestoreStore } from './store.js';
import { PrivateStore } from './private-store.js';

initializeApp();
const encryptionKey = defineSecret('CLOUD03_ENCRYPTION_KEY');
const origin = defineString('CLOUD03_ORIGIN', { description: 'HTTPS origin of the dedicated Cloud03 bridge Hosting site, without a trailing slash' });
let handler: ReturnType<typeof createApp> | undefined;
export const cloud03Bridge = onRequest({ region: 'asia-east1', memory: '256MiB',
  minInstances: 0, maxInstances: 2, timeoutSeconds: 60, secrets: [encryptionKey], invoker: 'public' }, (req, res) => {
  if (!handler) {
    const store = new PrivateStore(new FirestoreStore(getFirestore()), Buffer.from(encryptionKey.value(), 'base64'));
    const provider = new StudioOAuth(store, origin.value(), async token => {
      const identity = await getAuth().verifyIdToken(token, true);
      if (identity.firebase.sign_in_provider !== 'google.com') throw Error('Use Google sign-in');
      return identity;
    }, async uid => { try { return !(await getAuth().getUser(uid)).disabled; } catch { return false; } });
    handler = createApp(provider, new RecordService(store));
  }
  return handler(req, res);
});
