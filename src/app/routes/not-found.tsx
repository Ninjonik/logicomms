import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  ErrorActions,
  ErrorDescription,
  ErrorHeader,
  ErrorView,
} from "@/features/errors/error-base";

export default function NotFoundErrorPage() {
  const navigate = useNavigate();
  const handleGoBack = () => navigate(-1);

  return (
    <ErrorView>
      <ErrorHeader>Page not found</ErrorHeader>
      <ErrorDescription>
        Sorry, we couldn't find the page you're looking for.
      </ErrorDescription>
      <ErrorActions>
        <Button onClick={handleGoBack} size="lg">
          Go back
        </Button>
        <Button size="lg" variant="ghost">
          Contact support{" "}
          <span aria-hidden="true" className="ml-1">
            &rarr;
          </span>
        </Button>
      </ErrorActions>
    </ErrorView>
  );
}

// Necessary for react router to lazy load.
export const Component = NotFoundErrorPage;
