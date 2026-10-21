import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { MindPanel, type MindCommand } from '@/components/agent/MindPanel';
import { AgentActivityIndicator } from '@/components/agent/AgentActivityIndicator';
import type { AgentTelemetry } from '@/xmpp/pep/telemetry';
import type { HookEvent } from '@/xmpp/pep/hooks';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const commands: MindCommand[] = [
  { node: 'status', name: 'status', group: 'safe' },
  { node: 'abort', name: 'abort', group: 'maintenance' },
];
const tel: AgentTelemetry = {
  activity: 'available',
  availability: '',
  context: { used: 500, max: 1000 },
  tokens: { input: 10, output: 20 },
  cost: { usd: 0 },
  model: 'gpt',
};

describe('MindPanel', () => {
  it('navigates to the integrated Brain view when a jid is provided', async () => {
    const url = 'https://example.invalid/brain?view=memory#notes';
    const { getByText } = render(
      <MindPanel pendingApprovals={0} timeline={[]} commands={[]} onCommand={() => {}} brainUrl={url} jid="agent@fuentelibre.org" />,
    );
    fireEvent.press(getByText('Abrir el cerebro del agente'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/brain/[jid]',
      params: { jid: encodeURIComponent('agent@fuentelibre.org') },
    });
    mockPush.mockClear();
  });
  it('is honest about missing cost and tool', () => {
    const { getByText } = render(
      <MindPanel telemetry={tel} pendingApprovals={0} timeline={[]} commands={commands} onCommand={() => {}} />,
    );
    expect(getByText('sin tarifa')).toBeTruthy();
    expect(getByText('ninguna')).toBeTruthy();
    expect(getByText('500 / 1000 (50%)')).toBeTruthy();
  });

  it('shows pending badge', () => {
    const { getByText } = render(
      <MindPanel telemetry={tel} pendingApprovals={2} timeline={[]} commands={[]} onCommand={() => {}} />,
    );
    expect(getByText('2 aprobaciones pendientes')).toBeTruthy();
  });

  it('safe chip fires once; maintenance needs double tap within 3s', () => {
    jest.useFakeTimers();
    const onCommand = jest.fn();
    const { getByLabelText, queryByLabelText } = render(
      <MindPanel telemetry={tel} pendingApprovals={0} timeline={[]} commands={commands} onCommand={onCommand} />,
    );
    fireEvent.press(getByLabelText('status'));
    expect(onCommand).toHaveBeenCalledWith('status');
    onCommand.mockClear();

    fireEvent.press(getByLabelText('abort'));
    expect(onCommand).not.toHaveBeenCalled();
    fireEvent.press(getByLabelText('¿Seguro? toca de nuevo'));
    expect(onCommand).toHaveBeenCalledWith('abort');

    onCommand.mockClear();
    fireEvent.press(getByLabelText('abort'));
    act(() => {
      jest.advanceTimersByTime(3100);
    });
    expect(queryByLabelText('¿Seguro? toca de nuevo')).toBeNull();
    fireEvent.press(getByLabelText('abort'));
    expect(onCommand).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('shows at most 5 timeline items', () => {
    const timeline: HookEvent[] = Array.from({ length: 8 }, (_, i) => ({
      node: 'n',
      event: 'activity',
      state: `s${i}`,
    }));
    const { getAllByTestId } = render(
      <MindPanel telemetry={tel} pendingApprovals={0} timeline={timeline} commands={[]} onCommand={() => {}} />,
    );
    expect(getAllByTestId('timeline-item')).toHaveLength(5);
  });
});

describe('AgentActivityIndicator', () => {
  it('renders nothing when idle', () => {
    expect(render(<AgentActivityIndicator activity="available" tool="x" />).toJSON()).toBeNull();
    expect(render(<AgentActivityIndicator progressState="end" />).toJSON()).toBeNull();
  });
  it('shows thinking, with tool when present', () => {
    expect(render(<AgentActivityIndicator activity="processing" />).getByText('pensando…')).toBeTruthy();
    expect(
      render(<AgentActivityIndicator progressState="start" tool="bash" />).getByText('pensando · bash'),
    ).toBeTruthy();
  });
});
