import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, doc, getDocs, setDoc, query, orderBy, limit } from 'firebase/firestore';

const DATA_DIR = path.join(process.cwd(), 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');

export interface User {
  id: string;
  email: string;
  passwordHash?: string;
  name: string;
  role: 'admin' | 'user';
  googleId?: string;
  avatarUrl?: string;
  createdAt: string;
}

export interface Session {
  userId: string;
  email: string;
  phone?: string;
  status: 'connected' | 'disconnected' | 'connecting';
  pairedAt?: string;
  sessionToken?: string;
  mode?: 'public' | 'private';
  antidelete?: boolean;
}

export interface Log {
  id: string;
  userId: string;
  email: string;
  action: string;
  message: string;
  timestamp: string;
}

// Default admin setup
const DEFAULT_ADMIN: User = {
  id: 'usr_admin',
  email: 'kashafhijjaze@gmail.com',
  passwordHash: bcrypt.hashSync('Kashaf6573', 10),
  name: 'Kashaf Hijjaze',
  role: 'admin',
  createdAt: new Date().toISOString()
};

// Global in-memory cache
let cachedUsers: User[] = [];
let cachedSessions: Session[] = [];
let cachedLogs: Log[] = [];

// Initialize Firebase client SDK safely for server use
const CONFIG_FILE = path.join(process.cwd(), 'firebase-applet-config.json');
let firestoreDb: any = null;

try {
  if (fs.existsSync(CONFIG_FILE)) {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (config.projectId) {
      const app = initializeApp(config);
      firestoreDb = getFirestore(app, config.firestoreDatabaseId);
      console.log('Firebase client SDK initialized successfully on server with project:', config.projectId, 'and database:', config.firestoreDatabaseId || '(default)');
    }
  }
} catch (err) {
  console.error('Failed to initialize Firebase client SDK on server, falling back to local files:', err);
}

// Safely sanitize objects to remove any 'undefined' properties before writing to Firestore
function cleanUndefined<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

// Synchronous loading of local files (as fallback / initial setup)
function loadLocalData() {
  // Load users
  try {
    if (!fs.existsSync(USERS_FILE)) {
      cachedUsers = [DEFAULT_ADMIN];
      fs.writeFileSync(USERS_FILE, JSON.stringify(cachedUsers, null, 2));
    } else {
      const data = fs.readFileSync(USERS_FILE, 'utf-8');
      cachedUsers = JSON.parse(data || '[]');
    }
  } catch (err) {
    cachedUsers = [DEFAULT_ADMIN];
  }

  // Ensure default admin exists
  const adminIndex = cachedUsers.findIndex(u => u.email.toLowerCase() === 'kashafhijjaze@gmail.com');
  if (adminIndex === -1) {
    cachedUsers.push(DEFAULT_ADMIN);
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(cachedUsers, null, 2)); } catch (e) {}
  } else {
    if (cachedUsers[adminIndex].role !== 'admin') {
      cachedUsers[adminIndex].role = 'admin';
      try { fs.writeFileSync(USERS_FILE, JSON.stringify(cachedUsers, null, 2)); } catch (e) {}
    }
  }

  // Load sessions
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      cachedSessions = JSON.parse(data || '[]');
    } else {
      cachedSessions = [];
    }
  } catch (err) {
    cachedSessions = [];
  }

  // Load logs
  try {
    if (fs.existsSync(LOGS_FILE)) {
      const data = fs.readFileSync(LOGS_FILE, 'utf-8');
      cachedLogs = JSON.parse(data || '[]');
    } else {
      cachedLogs = [];
    }
  } catch (err) {
    cachedLogs = [];
  }
}

// Initial sync
loadLocalData();

// Async loader to sync from Firestore on boot
export async function loadFromFirestore(): Promise<void> {
  if (!firestoreDb) {
    console.log('Firestore is not active, using local file databases.');
    return;
  }
  try {
    console.log('Syncing data from Cloud Firestore database...');
    
    // Load Users
    const usersSnapshot = await getDocs(collection(firestoreDb, 'users'));
    if (!usersSnapshot.empty) {
      const users: User[] = [];
      usersSnapshot.forEach((doc: any) => {
        users.push(doc.data() as User);
      });
      cachedUsers = users;
      console.log(`Loaded ${users.length} users from Firestore.`);
    } else {
      // Seed firestore with local users
      console.log('Firestore users collection is empty. Seeding Firestore with default users.');
      for (const user of cachedUsers) {
        await setDoc(doc(firestoreDb, 'users', user.id), cleanUndefined(user));
      }
    }

    // Load Sessions
    const sessionsSnapshot = await getDocs(collection(firestoreDb, 'sessions'));
    if (!sessionsSnapshot.empty) {
      const sessions: Session[] = [];
      sessionsSnapshot.forEach((doc: any) => {
        sessions.push(doc.data() as Session);
      });
      cachedSessions = sessions;
      console.log(`Loaded ${sessions.length} sessions from Firestore.`);
    } else {
      // Seed firestore with local sessions if any
      if (cachedSessions.length > 0) {
        for (const session of cachedSessions) {
          await setDoc(doc(firestoreDb, 'sessions', session.userId), cleanUndefined(session));
        }
      }
    }

    // Load Logs
    const logsSnapshot = await getDocs(query(collection(firestoreDb, 'logs'), orderBy('timestamp', 'desc'), limit(1000)));
    if (!logsSnapshot.empty) {
      const logs: Log[] = [];
      logsSnapshot.forEach((doc: any) => {
        logs.push(doc.data() as Log);
      });
      cachedLogs = logs;
      console.log(`Loaded ${logs.length} logs from Firestore.`);
    } else {
      // Seed logs if any
      if (cachedLogs.length > 0) {
        for (const log of cachedLogs.slice(0, 100)) {
          await setDoc(doc(firestoreDb, 'logs', log.id), cleanUndefined(log));
        }
      }
    }
  } catch (err) {
    console.error('Failed to load datasets from Firestore:', err);
  }
}

export function getUsers(): User[] {
  return cachedUsers;
}

export function saveUsers(users: User[]): void {
  cachedUsers = users;
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error('Error saving users file locally:', err);
  }

  if (firestoreDb) {
    // Save to Firestore in background
    Promise.all(
      users.map(user => setDoc(doc(firestoreDb, 'users', user.id), cleanUndefined(user)))
    ).catch(err => {
      console.error('Failed to save users to Firestore:', err);
    });
  }
}

export function getSessions(): Session[] {
  return cachedSessions;
}

export function saveSessions(sessions: Session[]): void {
  cachedSessions = sessions;
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    console.error('Error saving sessions file locally:', err);
  }

  if (firestoreDb) {
    // Save to Firestore in background
    Promise.all(
      sessions.map(session => setDoc(doc(firestoreDb, 'sessions', session.userId), cleanUndefined(session)))
    ).catch(err => {
      console.error('Failed to save sessions to Firestore:', err);
    });
  }
}

export function getLogs(): Log[] {
  return cachedLogs;
}

export function addLog(userId: string, email: string, action: string, message: string): void {
  try {
    const newLog: Log = {
      id: 'log_' + Math.random().toString(36).substr(2, 9),
      userId,
      email,
      action,
      message,
      timestamp: new Date().toISOString()
    };
    cachedLogs.unshift(newLog);
    // Limit to 1000 logs
    if (cachedLogs.length > 1000) {
      cachedLogs.splice(1000);
    }
    
    try {
      fs.writeFileSync(LOGS_FILE, JSON.stringify(cachedLogs, null, 2));
    } catch (err) {}

    if (firestoreDb) {
      setDoc(doc(firestoreDb, 'logs', newLog.id), cleanUndefined(newLog)).catch((err: any) => {
        console.error('Failed to save log entry to Firestore:', err);
      });
    }
  } catch (err) {
    console.error('Error adding log:', err);
  }
}

export function getBotMode(userId: string): 'public' | 'private' {
  const session = cachedSessions.find(s => s.userId === userId);
  return (session && session.mode) || 'public';
}

export function setBotMode(userId: string, mode: 'public' | 'private'): void {
  const sessionIndex = cachedSessions.findIndex(s => s.userId === userId);
  if (sessionIndex !== -1) {
    cachedSessions[sessionIndex].mode = mode;
    saveSessions(cachedSessions);
  } else {
    // If session doesn't exist yet, we can pre-create it or save it
    const newSess: Session = {
      userId,
      email: 'guest', // Default/fallback
      status: 'disconnected',
      mode
    };
    cachedSessions.push(newSess);
    saveSessions(cachedSessions);
  }
}

export function getAntiDelete(userId: string): boolean {
  const session = cachedSessions.find(s => s.userId === userId);
  // Default to true (enabled) if not specified
  return session && session.antidelete !== undefined ? session.antidelete : true;
}

export function setAntiDelete(userId: string, enabled: boolean): void {
  const sessionIndex = cachedSessions.findIndex(s => s.userId === userId);
  if (sessionIndex !== -1) {
    cachedSessions[sessionIndex].antidelete = enabled;
    saveSessions(cachedSessions);
  } else {
    const newSess: Session = {
      userId,
      email: 'guest',
      status: 'disconnected',
      antidelete: enabled
    };
    cachedSessions.push(newSess);
    saveSessions(cachedSessions);
  }
}

export function getFirestoreDb(): any {
  return firestoreDb;
}


