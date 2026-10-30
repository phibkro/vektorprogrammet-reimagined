import { PostForm } from "@/components/form/postForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ChoosePasswordForm } from "@/forms/account";
import { fieldErrors } from "@/lib/outcome";

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
            <PostForm
              action={
                activation
                  ? "/api/account/activate"
                  : "/api/account/reset-password"
              }
              className="grid gap-4"
              defaults={{ code, password: "" }}
              schema={ChoosePasswordForm.schema}
              serverIssues={fieldErrors(null)}
            >
              {(Field) => (
                <>
                  <input name="code" type="hidden" value={code} />
                  <Field label="Nytt passord" name="password">
                    <Input
                      autoComplete="new-password"
                      id="password"
                      required
                      type="password"
                    />
                  </Field>
                  <p>Bruk 8–64 tegn og høyst 72 UTF-8-byte.</p>
                  <Button type="submit">
                    {activation ? "Aktiver og logg inn" : "Lagre passord"}
                  </Button>
                </>
              )}
            </PostForm>
          )}
        </CardContent>
      </Card>
    </main>
  );
};
