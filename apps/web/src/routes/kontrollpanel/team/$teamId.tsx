import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, Schema } from "effect";

import { Choice, firstValue, optionsOf } from "@/components/form/choice";
import { PageHeader } from "@/components/panel/pageHeader";
import { CommandSheet } from "@/components/panel/panelSheets";
import { TeamFields, teamDefaults } from "@/components/panel/teamForms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InviteAccountForm } from "@/forms/people";
import {
  AddMemberForm,
  CancelMembershipForm,
  ChangeMembershipForm,
  DeactivateTeamForm,
  EndMembershipForm,
  ExtendMembershipForm,
  UpdateTeamForm,
} from "@/forms/teams";
import { inviteAccount } from "@/functions/account.functions";
import {
  addMember,
  cancelMembership,
  changeMembership,
  deactivateTeam,
  endMembership,
  extendMembership,
  getTeam,
  saveTeam,
} from "@/functions/panel.functions";
import { pageData } from "@/lib/outcome";
import { MEMBERSHIP_STATE_LABEL, TEAM_FUNCTION_LABEL } from "@/lib/teamLabels";
import type { MemberRow } from "@/server/teams";

const routeApi = getRouteApi("/kontrollpanel/team/$teamId");

interface Option {
  readonly id: number;
  readonly name: string;
}

const rowButton = (label: string, member: MemberRow) => (
  <Button
    variant="outline"
    size="sm"
    aria-label={`${label} ${member.personName}`}
  />
);

/** The controls of one membership: only those that the grant table and the membership's state both offer. */
const MemberActions = ({
  member,
  positions,
  opened,
}: {
  member: MemberRow;
  positions: readonly Option[];
  opened: boolean;
}) => {
  const id = String(member.id);
  const positionChoices = optionsOf(positions);

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {member.canInvite && (
        <CommandSheet
          trigger={rowButton("Inviter", member)}
          triggerLabel="Inviter"
          title={`Inviter ${member.personName}`}
          description="En aktiveringslenke sendes til personens private e-post."
          action={inviteAccount}
          schema={InviteAccountForm.schema}
          defaults={{ personId: String(member.personId) }}
          submitLabel="Send invitasjon"
        />
      )}
      {member.canExtend && (
        <CommandSheet
          trigger={rowButton("Forleng", member)}
          triggerLabel="Forleng"
          title={`Forleng ${member.personName}`}
          description={`Medlemskapet slutter ${member.end.label}. Ingenting fortsetter av seg selv.`}
          action={extendMembership}
          schema={ExtendMembershipForm.schema}
          defaults={{ end: firstValue(member.extendChoices), id }}
          submitLabel="Forleng"
          defaultOpen={opened}
        >
          {(Field) => (
            <Field name="end" label="Ny slutt">
              <Choice options={member.extendChoices} />
            </Field>
          )}
        </CommandSheet>
      )}
      {member.canChange && (
        <CommandSheet
          trigger={rowButton("Endre", member)}
          triggerLabel="Endre"
          title={`Endre ${member.personName}`}
          description="Det gamle medlemskapet slutter før semesteret du velger, og et nytt begynner da."
          action={changeMembership}
          schema={ChangeMembershipForm.schema}
          defaults={{
            from: firstValue(member.changeChoices),
            id,
            leader: member.leader ? "on" : undefined,
            positionId: String(member.positionId),
          }}
          submitLabel="Endre"
        >
          {(Field) => (
            <>
              <Field name="from" label="Fra og med">
                <Choice options={member.changeChoices} />
              </Field>
              <Field name="positionId" label="Stilling">
                <Choice options={positionChoices} />
              </Field>
              <Field name="leader" label="Leder">
                <Switch />
              </Field>
            </>
          )}
        </CommandSheet>
      )}
      {member.canEnd && (
        <CommandSheet
          trigger={rowButton("Avslutt", member)}
          triggerLabel="Avslutt"
          title={`Avslutt ${member.personName}`}
          description="Medlemskapet slutter før semesteret du velger."
          action={endMembership}
          schema={EndMembershipForm.schema}
          defaults={{ id, semester: firstValue(member.endChoices) }}
          submitLabel="Avslutt"
        >
          {(Field) => (
            <Field name="semester" label="Første semester uten medlemskap">
              <Choice options={member.endChoices} />
            </Field>
          )}
        </CommandSheet>
      )}
      {member.canCancel && (
        <CommandSheet
          trigger={rowButton("Kanseller", member)}
          triggerLabel="Kanseller"
          title={`Kanseller ${member.personName}`}
          description="Medlemskapet har ikke begynt, og fjernes helt."
          action={cancelMembership}
          schema={CancelMembershipForm.schema}
          defaults={{ id }}
          submitLabel="Kanseller"
        />
      )}
    </div>
  );
};

const MemberTableRow = ({
  member,
  positions,
  opened,
}: {
  member: MemberRow;
  positions: readonly Option[];
  opened: boolean;
}) => (
  <TableRow>
    <TableCell>
      <span className="font-medium">{member.personName}</span>
    </TableCell>
    <TableCell>
      {member.positionName}
      {member.leader && " (leder)"}
    </TableCell>
    <TableCell>
      {member.start.label} – {member.end.label}
    </TableCell>
    <TableCell>
      <Badge variant={member.state === "Active" ? "default" : "outline"}>
        {MEMBERSHIP_STATE_LABEL[member.state]}
      </Badge>
    </TableCell>
    <TableCell className="text-right">
      <MemberActions member={member} positions={positions} opened={opened} />
    </TableCell>
  </TableRow>
);

const TeamPage = () => {
  const {
    canAdd,
    canDeactivate,
    canEdit,
    current,
    members,
    people,
    positions,
    semesters,
    team,
  } = routeApi.useLoaderData();

  const { forleng } = routeApi.useSearch();
  const personChoices = optionsOf(people);
  const positionChoices = optionsOf(positions);
  const teamId = String(team.id);

  return (
    <>
      <PageHeader
        title={team.name}
        description={`${team.departmentName}. ${TEAM_FUNCTION_LABEL[team.function]}. Standardperiode: ${team.defaultTerm} semester. Nåværende semester: ${current}.${team.active ? "" : " Teamet er deaktivert."}`}
        actions={
          <>
            {canAdd && team.active && (
              <CommandSheet
                trigger={<Button size="sm" />}
                triggerLabel="Legg til medlem"
                title="Legg til medlem"
                description="Slutten følger teamets standardperiode hvis du ikke velger noen."
                action={addMember}
                schema={AddMemberForm.schema}
                defaults={{
                  end: "",
                  leader: undefined,
                  personId: firstValue(personChoices),
                  positionId: firstValue(positionChoices),
                  start: firstValue(semesters),
                  teamId,
                }}
                submitLabel="Legg til"
              >
                {(Field) => (
                  <>
                    <Field name="personId" label="Person">
                      <Choice options={personChoices} />
                    </Field>
                    <Field name="positionId" label="Stilling">
                      <Choice options={positionChoices} />
                    </Field>
                    <Field name="leader" label="Leder">
                      <Switch />
                    </Field>
                    <Field name="start" label="Fra og med">
                      <Choice options={semesters} />
                    </Field>
                    <Field name="end" label="Til og med">
                      <Choice
                        blank="Teamets standardperiode"
                        options={semesters}
                      />
                    </Field>
                  </>
                )}
              </CommandSheet>
            )}
            {canEdit && (
              <CommandSheet
                trigger={<Button variant="outline" size="sm" />}
                triggerLabel="Rediger team"
                title="Rediger team"
                action={saveTeam}
                schema={UpdateTeamForm.schema}
                defaults={{
                  ...teamDefaults(team),
                  departmentId: "",
                  id: teamId,
                }}
                submitLabel="Lagre"
              >
                {(Field) => <TeamFields Field={Field} />}
              </CommandSheet>
            )}
            {canDeactivate && team.active && (
              <CommandSheet
                trigger={<Button variant="outline" size="sm" />}
                triggerLabel="Deaktiver team"
                title="Deaktiver team"
                description="Et team slettes aldri. Et deaktivert team tar ikke imot nye medlemmer."
                action={deactivateTeam}
                schema={DeactivateTeamForm.schema}
                defaults={{ id: teamId }}
                submitLabel="Deaktiver"
              />
            )}
          </>
        }
      />
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Navn</TableHead>
                <TableHead>Stilling</TableHead>
                <TableHead>Periode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>
                  <span className="sr-only">Handlinger</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Arr.map(members, (member) => (
                <MemberTableRow
                  key={member.id}
                  member={member}
                  positions={positions}
                  opened={forleng === member.id}
                />
              ))}
              {members.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5}>Ingen medlemmer ennå.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
};

const SearchInput = Schema.toStandardSchemaV1(
  Schema.Struct({ forleng: Schema.optionalKey(Schema.Finite) })
);

/**
 * Spec 0006: one team and its memberships. `?forleng=<id>` (the link of the "ending soon" e-mail) opens the extend
 * form of that membership.
 */
export const Route = createFileRoute("/kontrollpanel/team/$teamId")({
  component: TeamPage,
  loader: ({ params }) =>
    getTeam({ data: { id: Number(params.teamId) } }).then(pageData),
  validateSearch: SearchInput,
});
