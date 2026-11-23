import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../test/server.ts';
import { listSessions } from './api.ts';

const unreachable = /can't reach the om api server/i;

describe('api errors', () => {
  it('explains when the API server is down (proxy 502)', async () => {
    server.use(http.get('*/api/users/ada/sessions', () => new HttpResponse(null, { status: 502 })));
    await expect(listSessions('ada')).rejects.toThrow(unreachable);
  });

  it('explains when the network request fails outright', async () => {
    server.use(http.get('*/api/users/ada/sessions', () => HttpResponse.error()));
    await expect(listSessions('ada')).rejects.toThrow(unreachable);
  });

  it('uses the server message for API errors', async () => {
    server.use(
      http.get('*/api/users/ada/sessions', () =>
        HttpResponse.json({ message: 'Nope' }, { status: 400 }),
      ),
    );
    await expect(listSessions('ada')).rejects.toThrow('Nope');
  });

  it('rejects a successful response of the wrong shape', async () => {
    server.use(http.get('*/api/users/ada/sessions', () => HttpResponse.json([{ id: 42 }])));
    await expect(listSessions('ada')).rejects.toThrow(/unexpected response/i);
  });
});
