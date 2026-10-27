import { describe, it, expect } from 'vitest';
import { canTransition, nextState } from './stateMachine.js';

describe('state machine', () => {
  it('allows only the next sequential state', () => {
    expect(canTransition('Requirement Verified', 'FS Drafted')).toBe(true);
    expect(canTransition('Requirement Verified', 'FS Approved')).toBe(false);
    expect(canTransition('QA', 'Development')).toBe(false);
  });
  it('terminates at Deployed', () => expect(nextState('Deployed')).toBeNull());
});
