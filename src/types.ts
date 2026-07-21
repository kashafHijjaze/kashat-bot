export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  avatarUrl?: string;
  googleId?: string;
  createdAt?: string;
}

export interface Session {
  userId: string;
  email: string;
  phone?: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'qr';
  pairedAt?: string;
  qr?: string;
}

export interface SystemLog {
  id: string;
  userId: string;
  email: string;
  action: string;
  message: string;
  timestamp: string;
}
