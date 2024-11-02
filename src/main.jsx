import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createBrowserRouter,
  RouterProvider,
} from "react-router-dom";
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import './index.css'
import ErrorPage from './error-page.jsx'
import Root, { loader as rootLoader } from './routes/root.jsx'
import Pokemon, { loader as pokemonLoader } from './routes/pokemon.jsx'
import { queryClient } from './queryClient';

const router = createBrowserRouter([
  {
    path: "/",
    element: <Root />,
    errorElement: <ErrorPage />,
    loader: rootLoader,
    children: [
      {
        path: "pokemon/:pokemonId",
        element: <Pokemon />,
        loader: pokemonLoader,
      },
    ],  
  },
], {
  basename: "/pokedex"
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  </StrictMode>,
)
