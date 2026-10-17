// The `obsidian` stand-in for tests that import main.ts (and through it the
// view and settings tab). Those modules only need these names to exist at
// load time: the guard tests build a plugin with Object.create and never run
// a constructor, open a modal, or touch the DOM.
export { apiVersion, requestUrl } from "./obsidian-stub";

class Stub {}

export class Plugin extends Stub {}
export class ItemView extends Stub {}
export class Modal extends Stub {}
export class PluginSettingTab extends Stub {}
export class Setting extends Stub {}
export class Menu extends Stub {}
export class TFile extends Stub {}

export const notices: string[] = [];
export class Notice {
  constructor(message: string) {
    notices.push(message);
  }
  setMessage(): this {
    return this;
  }
  hide(): void {}
}

export const Platform = { isMobile: false, isDesktop: true, isMacOS: false };

export function setIcon(): void {}
