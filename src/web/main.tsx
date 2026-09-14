import React from 'react';
import ReactDOM from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import './styles.css';
import { App } from './App';
import { CloudTheme } from './CloudTheme';
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 60000 } },
});
const theme = createTheme({
  primaryColor: 'teal',
  primaryShade: 8,
  fontFamily:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  defaultRadius: 'md',
});
const router = createBrowserRouter([{ path: '*', element: <App /> }]);
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <Notifications position="top-right" />
      <QueryClientProvider client={queryClient}>
        <CloudTheme />
        <ModalsProvider>
          <RouterProvider router={router} />
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>
  </React.StrictMode>,
);
