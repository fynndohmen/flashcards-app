import { Injectable } from '@angular/core';

import {
  ApiCardImage,
  ApiErrorResponse,
  CardPushRequest,
  CardPushResponse,
  DeckPushRequest,
  DeckPushResponse,
  DeviceRegisterResponse,
  HealthResponse,
  ImagePushRequest,
  ImagePushResponse,
  ImageUploadInput,
  PullResponse,
} from './sync-api.models';

const SYNC_SERVER_BASE_URL = 'https://192.168.2.58';

export class SyncApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(message);
    this.name = 'SyncApiError';
  }
}

@Injectable({ providedIn: 'root' })
export class SyncApiService {
  async health(): Promise<HealthResponse> {
    return this.requestJson<HealthResponse>(
      '/health',
      {
        method: 'GET',
      },
      [200],
    );
  }

  async registerDevice(
    deviceId: string,
    deviceName: string,
    enrollmentSecret: string,
  ): Promise<DeviceRegisterResponse> {
    return this.requestJson<DeviceRegisterResponse>(
      '/api/devices/register',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Enrollment-Secret': enrollmentSecret,
        },
        body: JSON.stringify({
          id: deviceId,
          name: deviceName,
        }),
      },
      [200],
    );
  }

  async pull(since: number, token: string): Promise<PullResponse> {
    const safeSince = Math.max(0, Math.trunc(since));

    return this.requestJson<PullResponse>(
      `/api/sync/pull?since=${safeSince}`,
      {
        method: 'GET',
        headers: this.authHeaders(token),
      },
      [200],
    );
  }

  async pushDeck(request: DeckPushRequest, token: string): Promise<DeckPushResponse> {
    return this.requestJson<DeckPushResponse>(
      '/api/sync/push/deck',
      {
        method: 'POST',
        headers: this.jsonAuthHeaders(token),
        body: JSON.stringify(request),
      },
      [200, 409],
    );
  }

  async pushCard(request: CardPushRequest, token: string): Promise<CardPushResponse> {
    return this.requestJson<CardPushResponse>(
      '/api/sync/push/card',
      {
        method: 'POST',
        headers: this.jsonAuthHeaders(token),
        body: JSON.stringify(request),
      },
      [200, 409],
    );
  }

  async deleteImage(request: ImagePushRequest, token: string): Promise<ImagePushResponse> {
    return this.requestJson<ImagePushResponse>(
      '/api/sync/push/image',
      {
        method: 'POST',
        headers: this.jsonAuthHeaders(token),
        body: JSON.stringify(request),
      },
      [200, 409],
    );
  }

  async uploadImage(input: ImageUploadInput, token: string): Promise<ApiCardImage> {
    const form = new FormData();

    form.append('id', input.id);
    form.append('card_id', input.cardId);
    form.append('side', input.side);
    form.append('position', String(input.position));

    form.append('file', input.blob, input.fileName);

    return this.requestJson<ApiCardImage>(
      '/api/images',
      {
        method: 'POST',
        headers: this.authHeaders(token),
        body: form,
      },
      [201],
    );
  }

  async downloadImage(imageId: string, token: string): Promise<Blob> {
    const response = await fetch(this.buildUrl(`/api/images/${encodeURIComponent(imageId)}`), {
      method: 'GET',
      headers: this.authHeaders(token),
      cache: 'no-store',
    });

    if (!response.ok) {
      const body = await this.readResponseBody(response);

      throw this.createApiError(response, body);
    }

    return response.blob();
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    acceptedStatuses: number[],
  ): Promise<T> {
    const response = await fetch(this.buildUrl(path), {
      ...init,
      cache: 'no-store',
    });

    const body = await this.readResponseBody(response);

    if (!acceptedStatuses.includes(response.status)) {
      throw this.createApiError(response, body);
    }

    return body as T;
  }

  private buildUrl(path: string): string {
    const url = new URL(path, `${SYNC_SERVER_BASE_URL}/`);

    /*
     * The deployed Angular PWA has an Angular service
     * worker. Requests to the LAN sync server must bypass
     * it, otherwise failed cross-origin requests can be
     * turned into synthetic 504 responses.
     */
    url.searchParams.set('ngsw-bypass', 'true');

    return url.toString();
  }

  private authHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  private jsonAuthHeaders(token: string): Record<string, string> {
    return {
      ...this.authHeaders(token),
      'Content-Type': 'application/json',
    };
  }

  private async readResponseBody(response: Response): Promise<unknown> {
    const text = await response.text();

    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private createApiError(response: Response, body: unknown): SyncApiError {
    let message = `Sync API request failed with HTTP ${response.status}`;

    if (body && typeof body === 'object' && 'error' in body) {
      const apiError = body as ApiErrorResponse;

      if (typeof apiError.error === 'string') {
        message = apiError.error;
      }
    }

    return new SyncApiError(message, response.status, body);
  }
}
