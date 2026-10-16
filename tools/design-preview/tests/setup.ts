import { vi } from "vitest";
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi
    .fn()
    .mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
});
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver });
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.scrollTo = vi.fn();
window.scrollTo = vi.fn();
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.releasePointerCapture = () => {};
