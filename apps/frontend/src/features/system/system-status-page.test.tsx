import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiClient from '@/lib/api-client';
import { fetchReadiness, ApiClientError } from '@/lib/api-client';
import { SystemStatusPage } from './system-status-page';

vi.mock('@/lib/api-client', async (original) => ({
  ...(await original<typeof ApiClient>()),
  fetchReadiness: vi.fn(),
}));

const mockedGet = vi.mocked(fetchReadiness);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SystemStatusPage />
    </QueryClientProvider>,
  );
}

describe('SystemStatusPage', () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it('shows each dependency from the API', async () => {
    mockedGet.mockResolvedValue({
      status: 'down',
      checks: { mongodb: 'up', redisCache: 'down' },
    });
    renderPage();
    expect(await screen.findByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Operational')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('shows an error state when the API is unreachable', async () => {
    mockedGet.mockRejectedValue(new ApiClientError('Offline', undefined, 'NETWORK_ERROR'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline');
  });

  it('refetches when Refresh is pressed', async () => {
    mockedGet.mockResolvedValue({ status: 'up', checks: { mongodb: 'up' } });
    renderPage();
    await screen.findByText('Database');
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(mockedGet.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
