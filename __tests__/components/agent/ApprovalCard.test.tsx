import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ApprovalCard, type ApprovalButton } from '@/components/agent/ApprovalCard';

const NOW = 1_000_000;
const buttons: ApprovalButton[] = [
  { label: 'Ver', commandNode: 'x', style: 'secondary', kind: 'command' },
  { label: 'Permitir', value: 'allow', style: 'primary', kind: 'quick' },
  { label: 'permitir ', commandNode: 'y', style: 'secondary', kind: 'command' },
  { label: 'Denegar', value: 'deny', style: 'primary', kind: 'quick' },
];

const base = { title: '¿Aprobar?', buttons, onPress: () => {} };

describe('ApprovalCard', () => {
  it('dedupes by label and puts quick responses first', () => {
    const { getAllByRole } = render(<ApprovalCard {...base} />);
    expect(getAllByRole('button').map((b) => b.props.accessibilityLabel)).toEqual([
      'Permitir',
      'Denegar',
      'Ver',
    ]);
  });

  it('calls onPress with the button', () => {
    const onPress = jest.fn();
    const { getByLabelText } = render(<ApprovalCard {...base} onPress={onPress} />);
    fireEvent.press(getByLabelText('Denegar'));
    expect(onPress).toHaveBeenCalledWith(buttons[3]);
  });

  it('shows countdown with injected clock, red under 10s', () => {
    const { getByLabelText, rerender, getByText } = render(
      <ApprovalCard {...base} expiresAtMs={NOW + 42_000} nowMs={NOW} />,
    );
    expect(getByLabelText('caduca en 42 segundos')).toBeTruthy();
    const flat = (t: ReturnType<typeof getByText>) =>
      Array.isArray(t.props.style) ? Object.assign({}, ...t.props.style.flat()) : t.props.style;
    expect(flat(getByText('42')).color).toBe('#FFD740');
    rerender(<ApprovalCard {...base} expiresAtMs={NOW + 42_000} nowMs={NOW + 35_000} />);
    expect(flat(getByText('7')).color).toBe('#FF5252');
  });

  it('seals Expirado locally and removes buttons', () => {
    const { getByText, queryAllByRole } = render(
      <ApprovalCard {...base} expiresAtMs={NOW} nowMs={NOW + 1} />,
    );
    expect(getByText('Expirado')).toBeTruthy();
    expect(queryAllByRole('button')).toHaveLength(0);
  });

  it.each([
    [{ state: 'resolved', decision: 'allow-once' }, 'Aprobado'],
    [{ state: 'resolved', decision: 'deny' }, 'Rechazado'],
    [{ state: 'resolved' }, 'Resuelto'],
    [{ state: 'expired' }, 'Expirado'],
    [{ state: 'canceled' }, 'Cancelado'],
    [{ state: 'failed' }, 'Falló'],
  ])('maps decision %j to %s', (decision, text) => {
    const { getByText, queryAllByRole } = render(<ApprovalCard {...base} decision={decision} />);
    expect(getByText(text)).toBeTruthy();
    expect(queryAllByRole('button')).toHaveLength(0);
  });

  it('keeps pending state with buttons', () => {
    const { getAllByRole } = render(<ApprovalCard {...base} decision={{ state: 'pending' }} />);
    expect(getAllByRole('button')).toHaveLength(3);
  });
});
