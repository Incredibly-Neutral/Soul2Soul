import { describe, it, expect, vi } from 'vitest';
import { Observable } from '../../src/state/observable.js';

describe('Observable', () => {
  it('get() returns the initial value', () => {
    const o = new Observable<number>(42);
    expect(o.get()).toBe(42);
  });

  it('get() returns the value after set()', () => {
    const o = new Observable<string>('a');
    o.set('b');
    expect(o.get()).toBe('b');
  });

  it('update() derives the next value from the current one', () => {
    const o = new Observable<number>(1);
    o.update((n) => n * 10 + 1);
    expect(o.get()).toBe(11);
  });

  it('set() and update() notify all subscribers with the new value', () => {
    const o = new Observable<number>(0);
    const seen: number[] = [];
    const a = vi.fn((v: number) => seen.push(v));
    const b = vi.fn((v: number) => seen.push(v));
    o.subscribe(a);
    o.subscribe(b);

    o.set(5);
    expect(a).toHaveBeenNthCalledWith(1, 5);
    expect(b).toHaveBeenNthCalledWith(1, 5);

    o.update((n) => n + 1);
    expect(a).toHaveBeenNthCalledWith(2, 6);
    expect(b).toHaveBeenNthCalledWith(2, 6);
    expect(seen).toEqual([5, 5, 6, 6]);
  });

  it('subscribe() returns an unsubscribe function that removes the listener', () => {
    const o = new Observable<number>(0);
    const fn = vi.fn();
    const unsubscribe = o.subscribe(fn);

    o.set(1);
    expect(fn).toHaveBeenCalledTimes(1);

    // unsubscribe returns the Set.delete result (true = listener was present).
    const removed = unsubscribe();
    o.set(2);
    // Listener must not be called again after unsubscribe.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(removed).toBe(true);
    expect(unsubscribe()).toBe(false); // already gone -> false
  });

  it('unsubscribing one listener does not affect the others', () => {
    const o = new Observable<number>(0);
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = o.subscribe(a);
    o.subscribe(b);

    unsubA();
    o.set(9);

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not notify when a fresh listener is subscribed (no initial fire)', () => {
    const o = new Observable<number>(7);
    const fn = vi.fn();
    o.subscribe(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('works with object/array values (reference semantics, no cloning)', () => {
    const initial = { a: 1 };
    const o = new Observable<{ a: number }>(initial);
    expect(o.get()).toBe(initial); // same reference

    o.update((cur) => ({ ...cur, b: 2 }));
    expect(o.get()).toEqual({ a: 1, b: 2 });
    expect(o.get()).not.toBe(initial);
  });

  it('update() is synchronous and order-preserving', () => {
    const o = new Observable<number>(0);
    const order: string[] = [];
    o.subscribe(() => order.push('first'));
    o.subscribe(() => order.push('second'));
    o.update((n) => n + 1);
    expect(o.get()).toBe(1);
    expect(order).toEqual(['first', 'second']);
  });

  it('duplicate subscribers are each notified (Set semantics)', () => {
    const o = new Observable<number>(0);
    const fn = vi.fn();
    o.subscribe(fn);
    o.subscribe(fn); // same function registered twice
    o.set(3);
    expect(fn).toHaveBeenCalledTimes(1); // Set dedupes identical listeners
  });
});
