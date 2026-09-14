import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/web/App';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

describe('AppShell sm boundary regression (A16)', () => {
  it('keeps the fixed sidebar offset at exactly 768px and collapses only below sm', () => {
    // Render the actual application and Mantine-generated CSS, not a copy of its config.
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: ['/workouts'] },
          createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            createElement(App),
          ),
        ),
      ),
    );
    expect(html).toContain(
      '--app-shell-navbar-width:calc(14.375rem * var(--mantine-scale))',
    );
    expect(html).toContain(
      '--app-shell-navbar-offset:calc(14.375rem * var(--mantine-scale))',
    );
    // Without collapsed.mobile, Mantine emits max-width:48em and sets width:100%
    // at 768px, while our desktop navigation becomes visible at the same boundary.
    expect(html).not.toMatch(/@media\s*\(max-width:\s*48em\)/);
    expect(html).toContain('--app-shell-navbar-transform:translateX(');
    expect(html).toContain('id="main-content"');
    expect(html).toContain('正在加载页面');
    expect(html).toContain('href="/workouts"');
  });
});
