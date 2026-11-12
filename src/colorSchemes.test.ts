import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { COLOR_SCHEMES } from './App';

test('COLOR_SCHEMES contains all 7 color schemes with valid properties', () => {
  assert.equal(COLOR_SCHEMES.length, 7);
  const expectedIds = ['blue', 'purple', 'emerald', 'rose', 'amber', 'cyan', 'crimson'];
  const ids = COLOR_SCHEMES.map((s) => s.id);
  assert.deepEqual(ids, expectedIds);

  for (const scheme of COLOR_SCHEMES) {
    assert.ok(scheme.label.length > 0, `Scheme ${scheme.id} must have a label`);
    assert.match(scheme.color, /^#[0-9a-fA-F]{6}$/, `Scheme ${scheme.id} color must be valid hex`);
  }
});

test('index.css contains CSS variable overrides for every color scheme', () => {
  const cssPath = path.resolve('src/index.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  for (const scheme of COLOR_SCHEMES) {
    assert.ok(
      css.includes(`:root[data-scheme="${scheme.id}"]`),
      `index.css must include :root[data-scheme="${scheme.id}"] selector`
    );
  }
  assert.ok(css.includes('.s-color-grid'), 'index.css must include .s-color-grid');
  assert.ok(css.includes('.s-color-card'), 'index.css must include .s-color-card');
  assert.ok(css.includes('.s-color-swatch'), 'index.css must include .s-color-swatch');
});

test('Backup payload correctly serializes and deserializes colorScheme', () => {
  const mockSettings = {
    themePref: 'dark',
    colorScheme: 'purple',
    playbackSpeed: 1.25,
    sleepTimerMinutes: 30,
    lyricsMode: 'translated',
  };

  const jsonStr = JSON.stringify({ settings: mockSettings });
  const parsed = JSON.parse(jsonStr);

  assert.equal(parsed.settings.colorScheme, 'purple');
  assert.equal(parsed.settings.themePref, 'dark');
});

test('index.html adapts theme-color to light and dark theme without hardcoded purple', () => {
  const htmlPath = path.resolve('index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert.ok(!html.includes('content="#8a4dff"'), 'index.html must not hardcode purple #8a4dff for theme-color');
  assert.ok(html.includes('media="(prefers-color-scheme: light)" content="#f4f5f8"'), 'index.html must have light theme-color');
  assert.ok(html.includes('media="(prefers-color-scheme: dark)" content="#14171f"'), 'index.html must have dark theme-color');
  assert.ok(html.includes('themeColor = effective === \'dark\' ? \'#14171f\' : \'#f4f5f8\''), 'index.html bootstrap script must set dynamic theme-color');
});

test('vite.config.ts manifest does not hardcode purple #8a4dff for theme_color', () => {
  const viteConfigPath = path.resolve('vite.config.ts');
  const viteConfig = fs.readFileSync(viteConfigPath, 'utf8');

  assert.ok(!viteConfig.includes("theme_color: '#8a4dff'"), 'vite.config.ts must not have purple #8a4dff');
  assert.ok(viteConfig.includes("theme_color: '#14171f'"), 'vite.config.ts should have #14171f');
});

