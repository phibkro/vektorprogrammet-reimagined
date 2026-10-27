import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr } from "effect";

import { PageHeader } from "@/components/panel/pageHeader";
import { CommandSheet } from "@/components/panel/panelSheets";
import { EraseSheet, MergeSheet } from "@/components/panel/personalDataSheets";
import { ProfileFields } from "@/components/profileFields";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  deactivateAccount,
  inviteAccount,
  reactivateAccount,
  updateProfile,
} from "@/functions/account.functions";
import { getPeople, registerPerson } from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";

const routeApi = getRouteApi("/kontrollpanel/personer");

const PeoplePage = () => {
  const { canMerge, canRegister, fieldsOfStudy, people } =
    routeApi.useLoaderData();

  return (
    <>
      <PageHeader
        title="Personer"
        description="Personene i avdelingene dine. Avdelingen følger linjen personen studerer."
        actions={
          <>
            {canRegister && (
              <CommandSheet
                trigger={<Button size="sm" />}
                triggerLabel="Registrer person"
                title="Registrer person"
                description="Linjen bestemmer hvilken avdeling personen hører til."
                action={registerPerson}
                submitLabel="Registrer"
              >
                <ProfileFields
                  emailLabel="E-post"
                  fieldsOfStudy={fieldsOfStudy}
                />
              </CommandSheet>
            )}
            {canMerge && <MergeSheet people={people} />}
          </>
        }
      />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Navn</TableHead>
                <TableHead>E-post</TableHead>
                <TableHead>Avdeling</TableHead>
                <TableHead>Konto</TableHead>
                <TableHead>Handlinger</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Arr.map(people, (person) => (
                <TableRow key={person.id}>
                  <TableCell>
                    <span className="font-medium">{person.name}</span>
                  </TableCell>
                  <TableCell>{person.email}</TableCell>
                  <TableCell>{person.departmentName}</TableCell>
                  <TableCell>
                    {person.accountState === null
                      ? "Ingen konto"
                      : {
                          Active: "Aktiv",
                          Deactivated: "Deaktivert",
                          Invited: "Invitert",
                        }[person.accountState]}
                  </TableCell>
                  <TableCell>
                    {person.canEditProfile && (
                      <CommandSheet
                        trigger={
                          <Button
                            aria-label={`Rediger ${person.name}`}
                            size="sm"
                            variant="outline"
                          />
                        }
                        triggerLabel="Rediger"
                        title={`Rediger ${person.name}`}
                        action={updateProfile}
                        submitLabel="Lagre profil"
                      >
                        <input
                          name="personId"
                          type="hidden"
                          value={person.id}
                        />
                        <ProfileFields
                          fieldsOfStudy={fieldsOfStudy}
                          profile={person}
                        />
                      </CommandSheet>
                    )}
                    {person.canInvite && (
                      <CommandSheet
                        trigger={
                          <Button
                            aria-label={`Inviter ${person.name}`}
                            size="sm"
                            variant="outline"
                          />
                        }
                        triggerLabel="Inviter"
                        title={`Inviter ${person.name}`}
                        action={inviteAccount}
                        submitLabel="Send invitasjon"
                      >
                        <input
                          name="personId"
                          type="hidden"
                          value={person.id}
                        />
                      </CommandSheet>
                    )}
                    {person.canDeactivate && (
                      <CommandSheet
                        trigger={
                          <Button
                            aria-label={`Deaktiver ${person.name}`}
                            size="sm"
                            variant="outline"
                          />
                        }
                        triggerLabel="Deaktiver"
                        title={`Deaktiver ${person.name}`}
                        action={deactivateAccount}
                        submitLabel="Deaktiver konto"
                      >
                        <input
                          name="personId"
                          type="hidden"
                          value={person.id}
                        />
                      </CommandSheet>
                    )}
                    {person.canReactivate && (
                      <CommandSheet
                        trigger={
                          <Button
                            aria-label={`Reaktiver ${person.name}`}
                            size="sm"
                            variant="outline"
                          />
                        }
                        triggerLabel="Reaktiver"
                        title={`Reaktiver ${person.name}`}
                        action={reactivateAccount}
                        submitLabel="Reaktiver konto"
                      >
                        <input
                          name="personId"
                          type="hidden"
                          value={person.id}
                        />
                      </CommandSheet>
                    )}
                    {person.canErase && <EraseSheet person={person} />}
                  </TableCell>
                </TableRow>
              ))}
              {people.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5}>Ingen personer å vise ennå.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
};

/** Spec 0006: people of the principal's departments; the register control is there only when `createPerson` is granted. */
export const Route = createFileRoute("/kontrollpanel/personer")({
  component: PeoplePage,
  loader: () => getPeople().then(pageData),
});
