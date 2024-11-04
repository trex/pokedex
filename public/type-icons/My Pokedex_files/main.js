import __vite__cjsImport0_react_jsxDevRuntime from "/pokedex/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=88f5d930"; const jsxDEV = __vite__cjsImport0_react_jsxDevRuntime["jsxDEV"];
import __vite__cjsImport1_react from "/pokedex/node_modules/.vite/deps/react.js?v=88f5d930"; const StrictMode = __vite__cjsImport1_react["StrictMode"];
import __vite__cjsImport2_reactDom_client from "/pokedex/node_modules/.vite/deps/react-dom_client.js?v=88f5d930"; const createRoot = __vite__cjsImport2_reactDom_client["createRoot"];
import {
  createBrowserRouter,
  RouterProvider
} from "/pokedex/node_modules/.vite/deps/react-router-dom.js?v=88f5d930";
import { QueryClientProvider } from "/pokedex/node_modules/.vite/deps/@tanstack_react-query.js?v=88f5d930";
import { ReactQueryDevtools } from "/pokedex/node_modules/.vite/deps/@tanstack_react-query-devtools.js?v=88f5d930";
import "/pokedex/src/index.css?t=1730675394252";
import ErrorPage from "/pokedex/src/error-page.jsx";
import Root, { loader as rootLoader } from "/pokedex/src/routes/root.jsx?t=1730675447541";
import Pokemon, { loader as pokemonLoader } from "/pokedex/src/routes/pokemon.jsx";
import { queryClient } from "/pokedex/src/queryClient.js";
const router = createBrowserRouter(
  [
    {
      path: "/",
      element: /* @__PURE__ */ jsxDEV(Root, {}, void 0, false, {
        fileName: "/Users/trevorsmith/dev/pokedex/src/main.jsx",
        lineNumber: 18,
        columnNumber: 12
      }, this),
      errorElement: /* @__PURE__ */ jsxDEV(ErrorPage, {}, void 0, false, {
        fileName: "/Users/trevorsmith/dev/pokedex/src/main.jsx",
        lineNumber: 19,
        columnNumber: 17
      }, this),
      loader: rootLoader,
      children: [
        {
          path: "pokemon/:pokemonId",
          element: /* @__PURE__ */ jsxDEV(Pokemon, {}, void 0, false, {
            fileName: "/Users/trevorsmith/dev/pokedex/src/main.jsx",
            lineNumber: 24,
            columnNumber: 14
          }, this),
          loader: pokemonLoader
        }
      ]
    }
  ],
  {
    basename: "/pokedex"
  }
);
createRoot(document.getElementById("root")).render(
  /* @__PURE__ */ jsxDEV(StrictMode, { children: /* @__PURE__ */ jsxDEV(QueryClientProvider, { client: queryClient, children: [
    /* @__PURE__ */ jsxDEV(RouterProvider, { router }, void 0, false, {
      fileName: "/Users/trevorsmith/dev/pokedex/src/main.jsx",
      lineNumber: 36,
      columnNumber: 7
    }, this),
    /* @__PURE__ */ jsxDEV(ReactQueryDevtools, { initialIsOpen: false }, void 0, false, {
      fileName: "/Users/trevorsmith/dev/pokedex/src/main.jsx",
      lineNumber: 37,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "/Users/trevorsmith/dev/pokedex/src/main.jsx",
    lineNumber: 35,
    columnNumber: 5
  }, this) }, void 0, false, {
    fileName: "/Users/trevorsmith/dev/pokedex/src/main.jsx",
    lineNumber: 34,
    columnNumber: 3
  }, this)
);

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6IkFBaUJhO0FBakJiLFNBQVNBLGtCQUFrQjtBQUMzQixTQUFTQyxrQkFBa0I7QUFDM0I7QUFBQSxFQUNFQztBQUFBQSxFQUNBQztBQUFBQSxPQUNLO0FBQ1AsU0FBU0MsMkJBQTJCO0FBQ3BDLFNBQVNDLDBCQUEwQjtBQUNuQyxPQUFPO0FBQ1AsT0FBT0MsZUFBZTtBQUN0QixPQUFPQyxRQUFRQyxVQUFVQyxrQkFBa0I7QUFDM0MsT0FBT0MsV0FBV0YsVUFBVUcscUJBQXFCO0FBQ2pELFNBQVNDLG1CQUFtQjtBQUU1QixNQUFNQyxTQUFTWDtBQUFBQSxFQUFvQjtBQUFBLElBQ2pDO0FBQUEsTUFDRVksTUFBTTtBQUFBLE1BQ05DLFNBQVMsdUJBQUMsVUFBRDtBQUFBO0FBQUE7QUFBQTtBQUFBLGFBQUs7QUFBQSxNQUNkQyxjQUFjLHVCQUFDLGVBQUQ7QUFBQTtBQUFBO0FBQUE7QUFBQSxhQUFVO0FBQUEsTUFDeEJSLFFBQVFDO0FBQUFBLE1BQ1JRLFVBQVU7QUFBQSxRQUNSO0FBQUEsVUFDRUgsTUFBTTtBQUFBLFVBQ05DLFNBQVMsdUJBQUMsYUFBRDtBQUFBO0FBQUE7QUFBQTtBQUFBLGlCQUFRO0FBQUEsVUFDakJQLFFBQVFHO0FBQUFBLFFBQ1Y7QUFBQSxNQUFDO0FBQUEsSUFFTDtBQUFBLEVBQUM7QUFBQSxFQUNBO0FBQUEsSUFDRE8sVUFBVTtBQUFBLEVBQ1o7QUFBQztBQUVEakIsV0FBV2tCLFNBQVNDLGVBQWUsTUFBTSxDQUFDLEVBQUVDO0FBQUFBLEVBQzFDLHVCQUFDLGNBQ0MsaUNBQUMsdUJBQW9CLFFBQVFULGFBQzNCO0FBQUEsMkJBQUMsa0JBQWUsVUFBaEI7QUFBQTtBQUFBO0FBQUE7QUFBQSxXQUErQjtBQUFBLElBQy9CLHVCQUFDLHNCQUFtQixlQUFlLFNBQW5DO0FBQUE7QUFBQTtBQUFBO0FBQUEsV0FBeUM7QUFBQSxPQUYzQztBQUFBO0FBQUE7QUFBQTtBQUFBLFNBR0EsS0FKRjtBQUFBO0FBQUE7QUFBQTtBQUFBLFNBS0E7QUFDRiIsIm5hbWVzIjpbIlN0cmljdE1vZGUiLCJjcmVhdGVSb290IiwiY3JlYXRlQnJvd3NlclJvdXRlciIsIlJvdXRlclByb3ZpZGVyIiwiUXVlcnlDbGllbnRQcm92aWRlciIsIlJlYWN0UXVlcnlEZXZ0b29scyIsIkVycm9yUGFnZSIsIlJvb3QiLCJsb2FkZXIiLCJyb290TG9hZGVyIiwiUG9rZW1vbiIsInBva2Vtb25Mb2FkZXIiLCJxdWVyeUNsaWVudCIsInJvdXRlciIsInBhdGgiLCJlbGVtZW50IiwiZXJyb3JFbGVtZW50IiwiY2hpbGRyZW4iLCJiYXNlbmFtZSIsImRvY3VtZW50IiwiZ2V0RWxlbWVudEJ5SWQiLCJyZW5kZXIiXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsibWFpbi5qc3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgU3RyaWN0TW9kZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgY3JlYXRlUm9vdCB9IGZyb20gJ3JlYWN0LWRvbS9jbGllbnQnXG5pbXBvcnQge1xuICBjcmVhdGVCcm93c2VyUm91dGVyLFxuICBSb3V0ZXJQcm92aWRlcixcbn0gZnJvbSBcInJlYWN0LXJvdXRlci1kb21cIjtcbmltcG9ydCB7IFF1ZXJ5Q2xpZW50UHJvdmlkZXIgfSBmcm9tICdAdGFuc3RhY2svcmVhY3QtcXVlcnknO1xuaW1wb3J0IHsgUmVhY3RRdWVyeURldnRvb2xzIH0gZnJvbSAnQHRhbnN0YWNrL3JlYWN0LXF1ZXJ5LWRldnRvb2xzJztcbmltcG9ydCAnLi9pbmRleC5jc3MnXG5pbXBvcnQgRXJyb3JQYWdlIGZyb20gJy4vZXJyb3ItcGFnZS5qc3gnXG5pbXBvcnQgUm9vdCwgeyBsb2FkZXIgYXMgcm9vdExvYWRlciB9IGZyb20gJy4vcm91dGVzL3Jvb3QuanN4J1xuaW1wb3J0IFBva2Vtb24sIHsgbG9hZGVyIGFzIHBva2Vtb25Mb2FkZXIgfSBmcm9tICcuL3JvdXRlcy9wb2tlbW9uLmpzeCdcbmltcG9ydCB7IHF1ZXJ5Q2xpZW50IH0gZnJvbSAnLi9xdWVyeUNsaWVudCc7XG5cbmNvbnN0IHJvdXRlciA9IGNyZWF0ZUJyb3dzZXJSb3V0ZXIoW1xuICB7XG4gICAgcGF0aDogXCIvXCIsXG4gICAgZWxlbWVudDogPFJvb3QgLz4sXG4gICAgZXJyb3JFbGVtZW50OiA8RXJyb3JQYWdlIC8+LFxuICAgIGxvYWRlcjogcm9vdExvYWRlcixcbiAgICBjaGlsZHJlbjogW1xuICAgICAge1xuICAgICAgICBwYXRoOiBcInBva2Vtb24vOnBva2Vtb25JZFwiLFxuICAgICAgICBlbGVtZW50OiA8UG9rZW1vbiAvPixcbiAgICAgICAgbG9hZGVyOiBwb2tlbW9uTG9hZGVyLFxuICAgICAgfSxcbiAgICBdLCAgXG4gIH0sXG5dLCB7XG4gIGJhc2VuYW1lOiBcIi9wb2tlZGV4XCJcbn0pO1xuXG5jcmVhdGVSb290KGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdyb290JykpLnJlbmRlcihcbiAgPFN0cmljdE1vZGU+XG4gICAgPFF1ZXJ5Q2xpZW50UHJvdmlkZXIgY2xpZW50PXtxdWVyeUNsaWVudH0+XG4gICAgICA8Um91dGVyUHJvdmlkZXIgcm91dGVyPXtyb3V0ZXJ9IC8+XG4gICAgICA8UmVhY3RRdWVyeURldnRvb2xzIGluaXRpYWxJc09wZW49e2ZhbHNlfSAvPlxuICAgIDwvUXVlcnlDbGllbnRQcm92aWRlcj5cbiAgPC9TdHJpY3RNb2RlPixcbilcbiJdLCJmaWxlIjoiL1VzZXJzL3RyZXZvcnNtaXRoL2Rldi9wb2tlZGV4L3NyYy9tYWluLmpzeCJ9