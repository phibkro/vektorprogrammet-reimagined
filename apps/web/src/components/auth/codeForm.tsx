import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export const CodeForm = ({
  code,
  purpose,
}: {
  readonly code: string | undefined;
  readonly purpose: "activation" | "reset";
}) => {
  const activation = purpose === "activation";

  return (
    <main className="mx-auto grid min-h-svh max-w-md content-center px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>
            {activation ? "Aktiver konto" : "Velg nytt passord"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {code === undefined || code === "" ? (
            <p>Lenken mangler en kode.</p>
          ) : (
            <form
              action={
                activation
                  ? "/api/account/activate"
                  : "/api/account/reset-password"
              }
              className="grid gap-4"
              method="post"
            >
              <input name="code" type="hidden" value={code} />
              <label className="grid gap-1" htmlFor="password">
                Nytt passord
                <Input
                  autoComplete="new-password"
                  id="password"
                  name="password"
                  required
                  type="password"
                />
              </label>
              <p>Bruk 8–64 tegn og høyst 72 UTF-8-byte.</p>
              <Button type="submit">
                {activation ? "Aktiver og logg inn" : "Lagre passord"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
};
