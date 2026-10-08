export type SyncOperation = 'create' | 'update' | 'delete';
export type ImageSide = 'front' | 'back';

export interface ApiErrorResponse {
  error: string;
}

export interface HealthResponse {
  status: string;
  database: string;
}

export interface ApiDevice {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string;
}

export interface DeviceRegisterRequest {
  id: string;
  name: string;
}

export interface DeviceRegisterResponse {
  status: string;
  device: ApiDevice;
  token: string;
}

export interface ApiDeck {
  id: string;
  name: string;
  description?: string;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface ApiCard {
  id: string;
  deck_id: string;
  front_text: string;
  back_text: string;
  difficulty: number;
  last_reviewed_at?: string;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface ApiCardImage {
  id: string;
  card_id: string;
  side: ImageSide;
  position: number;
  storage_path: string;
  original_name?: string;
  mime_type?: string;
  sha256?: string;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface PullResponse {
  since: number;
  server_revision: number;
  decks: ApiDeck[];
  cards: ApiCard[];
  images: ApiCardImage[];
}

export interface DeckWrite {
  id: string;
  name: string;
  description?: string;
}

export interface DeckPushRequest {
  operation: SyncOperation;
  base_revision: number;
  deck: DeckWrite;
}

export interface DeckConflict {
  entity: string;
  id: string;
  base_revision: number;
  server_revision: number;
  server: ApiDeck;
}

export interface DeckPushResponse {
  status: 'applied' | 'conflict';
  deck?: ApiDeck;
  conflict?: DeckConflict;
}

export interface CardWrite {
  id: string;
  deck_id: string;
  front_text: string;
  back_text: string;
  difficulty: number;
  last_reviewed_at?: string;
}

export interface CardPushRequest {
  operation: SyncOperation;
  base_revision: number;
  card: CardWrite;
}

export interface CardConflict {
  entity: string;
  id: string;
  base_revision: number;
  server_revision: number;
  server: ApiCard;
}

export interface CardPushResponse {
  status: 'applied' | 'conflict';
  card?: ApiCard;
  conflict?: CardConflict;
}

export interface ImagePushRequest {
  operation: 'delete';
  base_revision: number;
  image: {
    id: string;
  };
}

export interface ImageConflict {
  entity: string;
  id: string;
  base_revision: number;
  server_revision: number;
  server: ApiCardImage;
}

export interface ImagePushResponse {
  status: 'applied' | 'conflict';
  image?: ApiCardImage;
  conflict?: ImageConflict;
}

export interface ImageUploadInput {
  id: string;
  cardId: string;
  side: ImageSide;
  position: number;
  blob: Blob;
  fileName: string;
}
