import { createBrowserRouter, RouterProvider } from "react-router";

const createAppRouter = () =>
  createBrowserRouter([
    {
      lazy: () => import("@/app/routes/home"),
      path: "/",
    },
    {
      lazy: () => import("@/app/routes/not-found"),
      path: "*",
    },
  ]);

export default function AppRouter() {
  return <RouterProvider router={createAppRouter()} />;
}
