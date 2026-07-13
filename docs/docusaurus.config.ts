import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'VigilQ',
  tagline: 'A self-hosted distributed job queue with AI-powered failure triage',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  // TODO: replace with the real domain once this is deployed (e.g. on Vercel)
  url: 'https://docs.vigilq.dev',
  baseUrl: '/',

  // TODO: replace once the GitHub repo exists
  organizationName: 'vigilq',
  projectName: 'vigilq',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/', // docs are the whole site — no separate /docs prefix
        },
        blog: false, // not needed for reference documentation
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/vigilq-social-card.jpg',
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'VigilQ',
      logo: {
        alt: 'VigilQ',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Quick start', to: '/'},
            {label: 'SDKs', to: '/sdks/typescript'},
            {label: 'Advanced setup', to: '/advanced/pools'},
          ],
        },
        {
          title: 'Reference',
          items: [
            {label: 'Environment variables', to: '/reference/environment-variables'},
            {label: 'REST API', to: '/reference/api'},
            {label: 'Dashboard', to: '/reference/dashboard'},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} VigilQ. Self-hosted, MIT licensed.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
