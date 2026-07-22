import * as BaileysModule from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { Boom } from '@hapi/boom';
import { getSessions, saveSessions, addLog, Session, getAntiDelete, getFirestoreDb, isFirestoreQuotaExhausted, handleFirestoreError } from './db';
import { handleIncomingMessage, handleDeletedMessage, unwrapMessage } from './commands';
import { collection, doc, getDocs, setDoc, deleteDoc, query, where, getDoc } from 'firebase/firestore';

// Robust resolver for Baileys module to support both ESM and bundled CommonJS environments
const makeWASocket = (() => {
  if (typeof BaileysModule === 'function') return BaileysModule;
  if (BaileysModule.default && typeof BaileysModule.default === 'function') return BaileysModule.default;
  if ((BaileysModule.default as any)?.default && typeof (BaileysModule.default as any).default === 'function') return (BaileysModule.default as any).default;
  if ((BaileysModule as any).makeWASocket) return (BaileysModule as any).makeWASocket;
  return BaileysModule;
})() as any;

const useMultiFileAuthState = BaileysModule.useMultiFileAuthState || (BaileysModule.default as any)?.useMultiFileAuthState;
const DisconnectReason = BaileysModule.DisconnectReason || (BaileysModule.default as any)?.DisconnectReason;
const fetchLatestBaileysVersion = BaileysModule.fetchLatestBaileysVersion || (BaileysModule.default as any)?.fetchLatestBaileysVersion;
const delay = BaileysModule.delay || (BaileysModule.default as any)?.delay;
const jidNormalizedUser = BaileysModule.jidNormalizedUser || (BaileysModule.default as any)?.jidNormalizedUser;
const Browsers = BaileysModule.Browsers || (BaileysModule.default as any)?.Browsers;

const SESSIONS_DIR = path.join(process.cwd(), 'data', 'baileys_sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

let ioInstance: any = null;
const activeSockets = new Map<string, any>();

export function setIoInstance(io: any) {
  ioInstance = io;
}

// Optimized caching and queueing for Firestore session sync to avoid rate limits and file errors
const lastSyncedContents = new Map<string, Map<string, string>>();
const syncQueues = new Map<string, SessionSyncQueue>();
const reconnectAttempts = new Map<string, number>();

class SessionSyncQueue {
  private userId: string;
  private isSyncing = false;
  private hasPending = false;
  private lastSyncTime = 0;
  private timeout: NodeJS.Timeout | null = null;

  constructor(userId: string) {
    this.userId = userId;
  }

  public trigger() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    const now = Date.now();
    const timeSinceLastSync = now - this.lastSyncTime;
    const minInterval = 5000; // Minimum 5 seconds between full syncs to avoid Firestore write-spam

    if (timeSinceLastSync >= minInterval) {
      this.execute();
    } else {
      const delayTime = minInterval - timeSinceLastSync;
      this.timeout = setTimeout(() => {
        this.execute();
      }, delayTime);
    }
  }

  private async execute() {
    if (this.isSyncing) {
      this.hasPending = true;
      return;
    }

    this.isSyncing = true;
    this.hasPending = false;
    this.lastSyncTime = Date.now();

    try {
      await syncSessionToFirestore(this.userId);
    } catch (err) {
      console.error(`[SessionSyncQueue] Error during sync for ${this.userId}:`, err);
    } finally {
      this.isSyncing = false;
      if (this.hasPending) {
        this.trigger();
      }
    }
  }

  public forceCancel() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
}

export async function syncSingleFileToFirestore(userId: string, filename: string): Promise<void> {
  const firestoreDb = getFirestoreDb();
  if (!firestoreDb || isFirestoreQuotaExhausted()) return;
  const sessionPath = getSessionPath(userId);
  const filePath = path.join(sessionPath, filename);
  if (!fs.existsSync(filePath)) return;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Check in-memory cache to prevent redundant writes
    const userCache = lastSyncedContents.get(userId) || new Map<string, string>();
    if (!lastSyncedContents.has(userId)) {
      lastSyncedContents.set(userId, userCache);
    }
    if (userCache.get(filename) === content) {
      return;
    }

    userCache.set(filename, content);
    
    // Enqueue a bundled sync to firestore which is debounced but reliable
    triggerSessionSyncToFirestore(userId);
    console.log(`[SessionSync] Enqueued debounced bundled sync for critical file ${filename} for ${userId}.`);
  } catch (err) {
    console.error(`[SessionSync] Error queueing file ${filename} for sync for ${userId}:`, err);
  }
}

export async function syncSessionFromFirestore(userId: string): Promise<void> {
  const firestoreDb = getFirestoreDb();
  if (!firestoreDb) {
    console.log(`[SessionSync] Firestore is not active. Skipping cloud restore for ${userId}.`);
    return;
  }
  const sessionPath = getSessionPath(userId);
  try {
    console.log(`[SessionSync] Syncing session files FROM cloud Firestore for user ${userId}...`);
    
    // Get or initialize user cache
    const userCache = lastSyncedContents.get(userId) || new Map<string, string>();
    if (!lastSyncedContents.has(userId)) {
      lastSyncedContents.set(userId, userCache);
    }

    // 1. First, try the bundled/packed format from 'baileys_sessions_v2'
    try {
      const docRef = doc(firestoreDb, 'baileys_sessions_v2', userId);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data && data.files) {
          let count = 0;
          for (const [filename, content] of Object.entries(data.files)) {
            const filePath = path.join(sessionPath, filename);
            fs.writeFileSync(filePath, content as string, 'utf-8');
            userCache.set(filename, content as string);
            count++;
          }
          console.log(`[SessionSync] Restored ${count} session files from bundled Firestore doc for user ${userId}.`);
          return;
        }
      }
    } catch (bundleErr) {
      handleFirestoreError(bundleErr, `syncSessionFromFirestore bundle for ${userId}`);
    }

    // 2. Fallback to individual legacy files if bundled doc is not present
    console.log(`[SessionSync] Bundled session doc not found. Falling back to individual legacy files for ${userId}...`);
    const q = query(collection(firestoreDb, 'baileys_auth_files'), where('userId', '==', userId));
    const querySnapshot = await getDocs(q);
    
    if (querySnapshot.empty) {
      console.log(`[SessionSync] No cloud session files found in legacy Firestore for ${userId}.`);
      return;
    }

    let count = 0;
    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (data && data.filename && data.content) {
        const filePath = path.join(sessionPath, data.filename);
        fs.writeFileSync(filePath, data.content, 'utf-8');
        userCache.set(data.filename, data.content);
        count++;
      }
    });
    console.log(`[SessionSync] Restored ${count} individual legacy session files from Firestore for user ${userId}.`);
  } catch (err) {
    handleFirestoreError(err, `syncSessionFromFirestore for ${userId}`);
  }
}

export async function syncSessionToFirestore(userId: string): Promise<void> {
  const firestoreDb = getFirestoreDb();
  if (!firestoreDb || isFirestoreQuotaExhausted()) return;
  const sessionPath = getSessionPath(userId);
  try {
    if (!fs.existsSync(sessionPath)) return;
    const localFiles = fs.readdirSync(sessionPath).filter(f => f.endsWith('.json'));
    
    console.log(`[SessionSync] Bundling up to ${localFiles.length} session files to Firestore for ${userId}...`);

    // Get or initialize user cache
    const userCache = lastSyncedContents.get(userId) || new Map<string, string>();
    if (!lastSyncedContents.has(userId)) {
      lastSyncedContents.set(userId, userCache);
    }

    const filesMap: { [filename: string]: string } = {};
    let hasChanges = false;

    for (const filename of localFiles) {
      const filePath = path.join(sessionPath, filename);
      if (!fs.existsSync(filePath)) continue;
      
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        filesMap[filename] = content;
        
        if (userCache.get(filename) !== content) {
          hasChanges = true;
          userCache.set(filename, content);
        }
      } catch (readErr: any) {
        if (readErr.code !== 'ENOENT') {
          console.error(`[SessionSync] Failed to read session file ${filename}:`, readErr);
        }
      }
    }

    // Check if any file in the user cache was deleted locally
    for (const cachedFilename of Array.from(userCache.keys())) {
      if (!filesMap[cachedFilename]) {
        hasChanges = true;
        userCache.delete(cachedFilename);
      }
    }

    if (!hasChanges) {
      console.log(`[SessionSync] No changes in session files detected for ${userId}. Skipping Firestore write.`);
      return;
    }

    // Save all files bundled as a single doc
    await setDoc(doc(firestoreDb, 'baileys_sessions_v2', userId), {
      userId,
      updatedAt: Date.now(),
      files: filesMap
    });
    
    console.log(`[SessionSync] Successfully synced bundled session files to Firestore for ${userId} (1 write operation).`);
  } catch (err) {
    handleFirestoreError(err, `syncSessionToFirestore for ${userId}`);
  }
}

export function triggerSessionSyncToFirestore(userId: string) {
  let queue = syncQueues.get(userId);
  if (!queue) {
    queue = new SessionSyncQueue(userId);
    syncQueues.set(userId, queue);
  }
  queue.trigger();
}

// Helper to get session directory
function getSessionPath(userId: string): string {
  const dir = path.join(SESSIONS_DIR, `session_${userId}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Read creds.json content for a user session
export function getCredsJson(userId: string): string {
  const credsPath = path.join(SESSIONS_DIR, `session_${userId}`, 'creds.json');
  if (!fs.existsSync(credsPath)) {
    throw new Error('No WhatsApp credentials file found for this session.');
  }
  return fs.readFileSync(credsPath, 'utf-8');
}

// Import and save custom creds.json content
export async function importCredsJson(userId: string, email: string, credsContent: string): Promise<any> {
  let parsed: any;
  try {
    parsed = JSON.parse(credsContent);
  } catch (e) {
    throw new Error('Invalid JSON format. Please ensure the file is valid JSON.');
  }

  if (!parsed || !parsed.noiseKey || !parsed.signedIdentityKey) {
    throw new Error('Invalid Baileys credentials file. Must contain "noiseKey" and "signedIdentityKey" attributes.');
  }

  // Create session directory and write creds.json
  const sessionPath = getSessionPath(userId);
  const credsPath = path.join(sessionPath, 'creds.json');
  fs.writeFileSync(credsPath, JSON.stringify(parsed, null, 2), 'utf-8');

  // Immediately push the newly imported credential file to Firestore to prevent overwrites
  await syncSessionToFirestore(userId);

  // Update session entry in database
  const sessions = getSessions();
  const sessionIndex = sessions.findIndex(s => s.userId === userId);
  
  // Try to pre-extract phone number if registered
  let phone = sessionIndex !== -1 ? sessions[sessionIndex].phone : undefined;
  if (parsed.me && parsed.me.id) {
    phone = parsed.me.id.split(':')[0];
  }

  const updatedSession: Session = {
    userId,
    email,
    status: 'connecting',
    phone
  };

  if (sessionIndex === -1) {
    sessions.push(updatedSession);
  } else {
    sessions[sessionIndex] = updatedSession;
  }
  saveSessions(sessions);

  addLog(userId, email, 'import_creds', `Imported creds.json successfully${phone ? ` (Phone: +${phone})` : ''}. Restoring session...`);
  if (ioInstance) {
    ioInstance.to(userId).emit('wa-status', updatedSession);
    ioInstance.to('admin').emit('admin-session-update', { userId, email, status: 'connecting', phone });
    ioInstance.to('admin').emit('admin-log-update', {
      id: 'log_' + Math.random().toString(36).substr(2, 9),
      userId,
      email,
      action: 'import_creds',
      message: `Imported creds.json successfully${phone ? ` (Phone: +${phone})` : ''}. Restoring session...`,
      timestamp: new Date().toISOString()
    });
  }

  // Asynchronously initialize the WhatsApp session from the newly written credentials
  setTimeout(() => {
    initWhatsAppSession(userId, email, false).catch(err => {
      console.error('Failed to initialize imported Baileys session:', err);
    });
  }, 500);

  return { success: true, phone };
}

// Disconnect and delete session state
export async function disconnectWhatsApp(userId: string, email: string) {
  addLog(userId, email, 'disconnect_attempt', 'Attempting to disconnect WhatsApp session...');
  
  const sock = activeSockets.get(userId);
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.end(undefined);
    } catch (e) {
      console.error('Error ending socket:', e);
    }
    activeSockets.delete(userId);
  }

  // Delete session folder
  const sessionPath = path.join(SESSIONS_DIR, `session_${userId}`);
  if (fs.existsSync(sessionPath)) {
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch (e) {
      console.error('Error deleting session path:', e);
    }
  }

  // Clear any pending sync queues
  const existingQueue = syncQueues.get(userId);
  if (existingQueue) {
    existingQueue.forceCancel();
    syncQueues.delete(userId);
  }

  // Delete session files from Firestore
  const firestoreDb = getFirestoreDb();
  if (firestoreDb && !isFirestoreQuotaExhausted()) {
    try {
      const q = query(collection(firestoreDb, 'baileys_auth_files'), where('userId', '==', userId));
      const querySnapshot = await getDocs(q);
      for (const docSnap of querySnapshot.docs) {
        await deleteDoc(docSnap.ref);
      }
      
      // Also delete bundled sessions doc
      try {
        await deleteDoc(doc(firestoreDb, 'baileys_sessions_v2', userId));
      } catch (bundleDelErr) {}
      
      console.log(`[SessionSync] Cleared Firestore session files for disconnected user: ${userId}`);
    } catch (err) {
      handleFirestoreError(err, `clearFirestoreSessionFiles for ${userId}`);
    }
  }

  // Update session entry in database
  const sessions = getSessions();
  const index = sessions.findIndex(s => s.userId === userId);
  if (index !== -1) {
    sessions[index].status = 'disconnected';
    sessions[index].phone = undefined;
    sessions[index].pairedAt = undefined;
    saveSessions(sessions);
  }

  if (ioInstance) {
    ioInstance.to(userId).emit('wa-status', { status: 'disconnected' });
    ioInstance.to('admin').emit('admin-session-update', { userId, status: 'disconnected' });
  }

  addLog(userId, email, 'disconnect', 'WhatsApp session disconnected and files cleared.');
  if (ioInstance) {
    ioInstance.to('admin').emit('admin-log-update', {
      id: 'log_' + Math.random().toString(36).substr(2, 9),
      userId,
      email,
      action: 'disconnect',
      message: 'WhatsApp session disconnected and files cleared.',
      timestamp: new Date().toISOString()
    });
  }
}

// Main logic to initialize WhatsApp socket
export async function initWhatsAppSession(
  userId: string,
  email: string,
  useQr: boolean = false,
  phoneToPair?: string,
  forceRestoreFromCloud: boolean = false
): Promise<any> {
  const sessionPath = getSessionPath(userId);
  const credsPath = path.join(sessionPath, 'creds.json');
  
  // Restore pre-existing files from cloud Firestore only if local credentials do not exist OR forceRestoreFromCloud is true
  if (!fs.existsSync(credsPath) || forceRestoreFromCloud) {
    await syncSessionFromFirestore(userId);
  } else {
    console.log(`[SessionSync] Local session files exist for ${userId}. Skipping cloud restore during socket initialization.`);
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  // Intercept credentials and key updates to synchronize with Firestore
  const customSaveCreds = async () => {
    await saveCreds();
    await syncSingleFileToFirestore(userId, 'creds.json');
    triggerSessionSyncToFirestore(userId);
  };

  const originalSetKeys = state.keys.set;
  state.keys.set = async (data: any) => {
    await originalSetKeys(data);
    triggerSessionSyncToFirestore(userId);
  };

  let version: any = [2, 3000, 1017004407]; // Modern stable Baileys version fallback
  try {
    const latest = await fetchLatestBaileysVersion();
    if (latest && latest.version) {
      version = latest.version;
    }
  } catch (err) {
    console.warn('[Baileys] Failed to fetch latest version, using fallback:', err);
  }

  // If there's an existing socket, clean it up first and remove all listeners to prevent ghost reconnection loops
  const existingSock = activeSockets.get(userId);
  if (existingSock) {
    try {
      existingSock.ev.removeAllListeners('connection.update');
      existingSock.ev.removeAllListeners('creds.update');
      existingSock.end(undefined);
    } catch (e) {}
    activeSockets.delete(userId);
  }

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: 'silent' }) as any,
    browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    markOnlineOnConnect: true,
    getMessage: async () => undefined
  });

  activeSockets.set(userId, sock);

  // Update database status to connecting
  const sessions = getSessions();
  const sessionIndex = sessions.findIndex(s => s.userId === userId);
  const updatedSession: Session = {
    userId,
    email,
    status: 'connecting',
    phone: phoneToPair || (sessionIndex !== -1 ? sessions[sessionIndex].phone : undefined)
  };

  if (sessionIndex === -1) {
    sessions.push(updatedSession);
  } else {
    sessions[sessionIndex] = updatedSession;
  }
  saveSessions(sessions);

  if (ioInstance) {
    ioInstance.to(userId).emit('wa-status', { status: 'connecting' });
    ioInstance.to('admin').emit('admin-session-update', { userId, status: 'connecting', email });
  }

  sock.ev.on('creds.update', customSaveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    for (const msg of m.messages) {
      handleIncomingMessage(sock, msg, userId, email).catch(err => {
        console.error('Error handling incoming WhatsApp message:', err);
      });
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    const antiDeleteEnabled = getAntiDelete(userId);
    if (!antiDeleteEnabled) return;

    for (const update of updates) {
      // 1. Check for protocolMessage revoke inside update or update.update
      const messageContent = (update as any).message || update.update?.message;
      const unwrappedUpdate = unwrapMessage(messageContent);
      const proto = unwrappedUpdate?.protocolMessage;
      const isProtoRevoke = proto && (proto.type === 3 || proto.type === 'REVOKE');

      // 2. Check for messageStubType revoke inside update.update
      const stubType = update.update?.messageStubType as any;
      const isStubRevoke = stubType === 1 || stubType === 'REVOKE' || stubType === 28 || stubType === 68 || stubType === 118;

      if (isProtoRevoke || isStubRevoke) {
        const deletedId = isProtoRevoke ? proto.key?.id : update.key?.id;
        const chatJid = isProtoRevoke ? (proto.key?.remoteJid || update.key?.remoteJid) : update.key?.remoteJid;
        const deletedByOwner = isProtoRevoke ? !!proto.key?.fromMe : !!update.key?.fromMe;

        if (deletedId && chatJid) {
          console.log(`[AntiDelete] Revocation detected in messages.update. Deleted ID: ${deletedId}, Chat ID: ${chatJid}, Proto: ${!!isProtoRevoke}, Stub: ${!!isStubRevoke}, Owner: ${deletedByOwner}`);
          handleDeletedMessage(sock, userId, deletedId, email, chatJid, deletedByOwner).catch(err => {
            console.error('Error handling delete in messages.update:', err);
          });
        }
      }
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && useQr) {
      console.log(`QR generated for ${userId}`);
      if (ioInstance) {
        ioInstance.to(userId).emit('wa-status', { status: 'qr', qr });
        ioInstance.to('admin').emit('admin-session-update', { userId, status: 'qr', qr, email });
      }
    }

    if (connection === 'close') {
      // Check if this socket has been superseded or removed from activeSockets.
      // If activeSockets.get(userId) is not this exact socket, we should ignore this event.
      const currentSock = activeSockets.get(userId);
      if (currentSock !== sock) {
        console.log(`Ignoring close event for non-active or superseded socket of user ${userId}`);
        return;
      }

      const err = lastDisconnect?.error;
      const errStr = err ? (err.message || String(err)) : '';
      const causeStr = (err as any)?.cause ? ((err as any).cause.message || String((err as any).cause)) : '';
      let isQrTimeout = errStr.includes('QR refs attempts ended') || causeStr.includes('QR refs attempts ended');
      
      if (!isQrTimeout && err) {
        try {
          const jsonStr = JSON.stringify(err);
          if (jsonStr.includes('QR refs attempts ended')) {
            isQrTimeout = true;
          }
        } catch (e) {}
      }
      
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      let shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      // If the error message or cause indicates a connection failure, network timeout, or socket issue, we MUST reconnect
      const lowerErrStr = errStr.toLowerCase();
      const lowerCauseStr = causeStr.toLowerCase();
      if (
        lowerErrStr.includes('connection') ||
        lowerErrStr.includes('failure') ||
        lowerErrStr.includes('timeout') ||
        lowerErrStr.includes('stream') ||
        lowerErrStr.includes('network') ||
        lowerErrStr.includes('unreachable') ||
        lowerErrStr.includes('eai_again') ||
        lowerErrStr.includes('enotfound') ||
        lowerErrStr.includes('econnreset') ||
        lowerCauseStr.includes('connection') ||
        lowerCauseStr.includes('failure') ||
        lowerCauseStr.includes('timeout') ||
        lowerCauseStr.includes('stream') ||
        lowerCauseStr.includes('network') ||
        lowerCauseStr.includes('unreachable') ||
        lowerCauseStr.includes('eai_again') ||
        lowerCauseStr.includes('enotfound') ||
        lowerCauseStr.includes('econnreset')
      ) {
        shouldReconnect = true;
      }

      if (isQrTimeout) {
        shouldReconnect = false;
      }

      const cleanReason = (errStr || causeStr || 'Disconnected').replace(/^Error:\s*/i, '');
      console.log(`Connection closed for ${userId}, reason: ${cleanReason}, isQrTimeout: ${isQrTimeout}, reconnecting: ${shouldReconnect}`);
      
      if (activeSockets.get(userId) === sock) {
        activeSockets.delete(userId);
      }

      if (!shouldReconnect) {
        // Logged out or QR timed out
        await disconnectWhatsApp(userId, email);
        const logAction = isQrTimeout ? 'qr_timeout' : 'logout';
        const logMsg = isQrTimeout ? 'WhatsApp connection pairing timed out (QR code expired).' : 'WhatsApp connection logged out.';
        addLog(userId, email, logAction, logMsg);
        if (ioInstance) {
          ioInstance.to('admin').emit('admin-log-update', {
            id: 'log_' + Math.random().toString(36).substr(2, 9),
            userId,
            email,
            action: logAction,
            message: logMsg,
            timestamp: new Date().toISOString()
          });
        }
      } else {
        // Stream error / restart required detection
        const isRestart = statusCode === DisconnectReason?.restartRequired || statusCode === 515 || lowerErrStr.includes('stream') || lowerErrStr.includes('restart') || lowerCauseStr.includes('stream') || lowerCauseStr.includes('restart');

        let delayMs = 1000;
        if (!isRestart) {
          const attempts = reconnectAttempts.get(userId) || 0;
          reconnectAttempts.set(userId, attempts + 1);
          delayMs = Math.min(3000 * Math.pow(1.5, attempts), 30000);
          console.log(`[Reconnection] Scheduling reconnect attempt ${attempts + 1} for ${userId} in ${Math.round(delayMs)}ms...`);
        } else {
          console.log(`[Reconnection] Stream restart required for ${userId}. Reconnecting immediately in 1s...`);
        }
        
        if (ioInstance) {
          ioInstance.to(userId).emit('wa-status', { status: 'connecting', message: isRestart ? 'Restarting connection stream...' : 'Reconnecting...' });
          ioInstance.to('admin').emit('admin-session-update', { userId, status: 'connecting', message: isRestart ? 'Restarting connection stream...' : 'Reconnecting...', email });
        }
        await delay(delayMs);

        // Before executing reconnect, verify if a new socket session was established during the delay
        if (activeSockets.has(userId) && activeSockets.get(userId) !== sock) {
          console.log(`A newer active session exists for user ${userId} during the reconnect delay. Aborting older reconnect loop.`);
          return;
        }

        initWhatsAppSession(userId, email, useQr);
      }
    } else if (connection === 'open') {
      reconnectAttempts.delete(userId);
      let connectedPhone = '';
      if (sock.user?.id) {
        const normalized = jidNormalizedUser(sock.user.id);
        if (normalized.endsWith('@s.whatsapp.net')) {
          connectedPhone = normalized.split('@')[0];
        } else {
          // If it is a LID or other JID, check if session already has a phone number
          const currentSessions = getSessions();
          const existingSess = currentSessions.find(s => s.userId === userId);
          if (existingSess && existingSess.phone) {
            connectedPhone = existingSess.phone;
          } else {
            connectedPhone = normalized.split('@')[0];
          }
        }
      }
      console.log(`WhatsApp connected successfully for ${userId}: ${connectedPhone}`);

      // Update Session DB
      const currentSessions = getSessions();
      const idx = currentSessions.findIndex(s => s.userId === userId);
      if (idx !== -1) {
        currentSessions[idx].status = 'connected';
        currentSessions[idx].phone = connectedPhone;
        currentSessions[idx].pairedAt = new Date().toISOString();
        saveSessions(currentSessions);
      } else {
        const newSess: Session = {
          userId,
          email,
          status: 'connected',
          phone: connectedPhone,
          pairedAt: new Date().toISOString()
        };
        currentSessions.push(newSess);
        saveSessions(currentSessions);
      }

      if (ioInstance) {
        ioInstance.to(userId).emit('wa-status', { 
          status: 'connected', 
          phone: connectedPhone,
          pairedAt: new Date().toISOString()
        });
        ioInstance.to('admin').emit('admin-session-update', { 
          userId,
          email,
          status: 'connected', 
          phone: connectedPhone,
          pairedAt: new Date().toISOString()
        });
      }

      addLog(userId, email, 'connect', `WhatsApp successfully linked and online: +${connectedPhone}`);
      
      // Force sync session state to Firestore on successful connection open to ensure we have valid credentials backed up
      await syncSessionToFirestore(userId);
      if (ioInstance) {
        ioInstance.to('admin').emit('admin-log-update', {
          id: 'log_' + Math.random().toString(36).substr(2, 9),
          userId,
          email,
          action: 'connect',
          message: `WhatsApp successfully linked and online: +${connectedPhone}`,
          timestamp: new Date().toISOString()
        });
      }

      // AUTO SEND MESSAGE TO OWN NUMBER
      try {
        let ownJid = '';
        if (sock.user?.id) {
          ownJid = jidNormalizedUser(sock.user.id);
        }

        // Only send if it's a valid phone JID (s.whatsapp.net) to avoid protocol errors with LIDs
        if (ownJid && ownJid.endsWith('@s.whatsapp.net')) {
          console.log(`Auto sending connection message to own JID: ${ownJid}`);
          
          // Message 1: Bot Connected
          await sock.sendMessage(ownJid, { text: '✅ Hijjaze Bot Connected' });
          
          // Message 2: Channel Invite
          const channelInviteText = '📢 View our WhatsApp Channel for more information.\n\nLink: https://whatsapp.com/channel/0029Vb7wo6O5a23w6LJo2K1y';
          await sock.sendMessage(ownJid, { text: channelInviteText });
          
          addLog(userId, email, 'auto_message', 'Successfully sent auto-connect notifications and Channel invitation to own WhatsApp number.');
          if (ioInstance) {
            ioInstance.to('admin').emit('admin-log-update', {
              id: 'log_' + Math.random().toString(36).substr(2, 9),
              userId,
              email,
              action: 'auto_message',
              message: 'Successfully sent auto-connect notifications and Channel invitation to own WhatsApp number.',
              timestamp: new Date().toISOString()
            });
          }
        } else {
          console.log(`Skipping auto-message for LID or non-phone JID: ${ownJid}`);
          addLog(userId, email, 'auto_message_skip', `Skipped auto-connect message for companion/LID JID: ${ownJid}`);
        }
      } catch (err: any) {
        console.error('Failed to send auto connection message:', err);
        addLog(userId, email, 'auto_message_error', `Failed auto-connect message: ${err.message}`);
        if (ioInstance) {
          ioInstance.to('admin').emit('admin-log-update', {
            id: 'log_' + Math.random().toString(36).substr(2, 9),
            userId,
            email,
            action: 'auto_message_error',
            message: `Failed auto-connect message: ${err.message}`,
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  });

  return sock;
}

// Generate pairing code for phone number
export async function generatePairingCode(userId: string, email: string, phone: string): Promise<string> {
  // Format phone number (digits only)
  let formattedPhone = phone.replace(/\D/g, '');
  if (formattedPhone.startsWith('00')) {
    formattedPhone = formattedPhone.substring(2);
  }

  if (!formattedPhone || formattedPhone.length < 8) {
    throw new Error('Please enter a valid phone number with country code (e.g., 923001234567).');
  }

  addLog(userId, email, 'pairing_request', `Generating WhatsApp pairing code for +${formattedPhone}`);

  // Disconnect any existing session files/sockets to ensure clean state
  await disconnectWhatsApp(userId, email);

  const sock = await initWhatsAppSession(userId, email, false, formattedPhone);
  
  // Wait a brief delay for WS connection setup
  await delay(3000);

  try {
    if (sock.authState?.creds?.registered) {
      throw new Error('Device is already linked. Disconnect first to pair a new number.');
    }

    const rawCode = await sock.requestPairingCode(formattedPhone);
    if (!rawCode) {
      throw new Error('WhatsApp servers did not return a pairing code. Please check your phone number.');
    }

    // Format 8-digit code as XXXX-XXXX for legibility
    const formattedCode = (rawCode.length === 8 && !rawCode.includes('-')) 
      ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` 
      : rawCode;

    addLog(userId, email, 'pairing_code_generated', `Pairing code successfully generated: ${formattedCode}`);
    return formattedCode;
  } catch (err: any) {
    console.error('[Baileys] Pairing code error:', err);
    addLog(userId, email, 'pairing_code_failed', `Pairing code failed: ${err.message || err}`);
    throw new Error(err.message || 'Failed to request pairing code from WhatsApp. Please verify the phone number.');
  }
}

// Send Custom message via active WhatsApp session
export async function sendWhatsAppMessage(userId: string, targetPhone: string, messageType: string, content: string, fileName?: string): Promise<any> {
  const sock = activeSockets.get(userId);
  if (!sock) {
    throw new Error('WhatsApp is not connected or active for this session. Please link first.');
  }

  // Format JID
  const formattedTarget = targetPhone.replace(/\D/g, '');
  const jid = formattedTarget.includes('@') ? formattedTarget : `${formattedTarget}@s.whatsapp.net`;

  let messagePayload: any = {};

  switch (messageType) {
    case 'text':
      messagePayload = { text: content };
      break;
    case 'image':
      messagePayload = { image: { url: content }, caption: fileName || 'Image from Hijjaze Bot' };
      break;
    case 'document':
      messagePayload = { document: { url: content }, fileName: fileName || 'Document.pdf', mimetype: 'application/pdf' };
      break;
    case 'audio':
      messagePayload = { audio: { url: content }, mimetype: 'audio/mp4', ptt: true };
      break;
    default:
      messagePayload = { text: content };
  }

  const result = await sock.sendMessage(jid, messagePayload);
  return result;
}

// Fetch participating WhatsApp groups
export async function getWhatsAppGroups(userId: string): Promise<any[]> {
  const sock = activeSockets.get(userId);
  if (!sock) {
    throw new Error('WhatsApp is not connected.');
  }

  const groups = await sock.groupFetchAllParticipating();
  return Object.values(groups).map((g: any) => ({
    id: g.id,
    subject: g.subject,
    owner: g.owner,
    creation: g.creation,
    size: g.participants?.length || 0
  }));
}

// Scan and automatically reconnect any pre-existing active sessions on boot
export async function autoConnectAllSessions() {
  console.log('Scanning database for connected sessions to auto-restore...');
  const sessions = getSessions();
  const connectedSessions = sessions.filter(s => s.status === 'connected');
  
  for (const session of connectedSessions) {
    try {
      console.log(`Auto-restoring session for user: ${session.email}`);
      await initWhatsAppSession(session.userId, session.email);
    } catch (err) {
      console.error(`Failed to auto-restore session for user ${session.email}:`, err);
    }
  }
}

// Graceful shutdown helpers to flush any pending session updates on exit
async function flushAllSyncQueues() {
  console.log('[Shutdown] Gracefully flushing all pending session syncs to Firestore...');
  const activeUserIds = Array.from(syncQueues.keys());
  for (const userId of activeUserIds) {
    const queue = syncQueues.get(userId);
    if (queue) {
      queue.forceCancel();
      try {
        console.log(`[Shutdown] Force syncing session to Firestore for user: ${userId}`);
        await syncSessionToFirestore(userId);
      } catch (err) {
        console.error(`[Shutdown] Failed to sync session for ${userId} during shutdown:`, err);
      }
    }
  }
  console.log('[Shutdown] All pending syncs completed.');
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Cleaning up...');
  await flushAllSyncQueues();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received. Cleaning up...');
  await flushAllSyncQueues();
  process.exit(0);
});
