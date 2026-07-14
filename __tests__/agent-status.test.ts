import { formatAgentActivity, formatAgentDetails, parseAgentStatus } from '@/xmpp/agentStatus';

describe('agent XMPP presence status', () => {
  it('parses pipe-delimited NanoClaw metrics', () => {
    const status = parseAgentStatus(
      'Tool: Bash | ctx 22% (28k/128k) | tok=28679 | in=962 | out=40 | req=2 | cost=0.0042',
    );

    expect(formatAgentActivity(status.activity)).toBe('Herramienta: Bash');
    expect(formatAgentDetails(status)).toEqual([
      'tok 28.7k in 962 out 40',
      'Req: 2',
      'Cost: $0.0042',
      'ctx 22% (28k/128k)',
    ]);
  });

  it('parses JSON status for future structured presence', () => {
    const status = parseAgentStatus(
      'nanoclaw:{"activity":"processing","tool":"sysadmin_logs","tokens":12345,"request":3,"model":"kilo/flash"}',
    );

    expect(formatAgentActivity(status.activity)).toBe('Trabajando');
    expect(formatAgentDetails(status)).toEqual([
      'Tool: sysadmin_logs',
      'tok 12.3k',
      'Req: 3',
      'kilo/flash',
    ]);
  });
});
