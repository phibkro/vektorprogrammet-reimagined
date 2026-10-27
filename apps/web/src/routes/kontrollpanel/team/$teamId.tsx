import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Array as Arr, Schema } from "effect";

import { Field, nativeSelectClass } from "@/components/forms";
import { PageHeader } from "@/components/panel/pageHeader";
import { CommandSheet } from "@/components/panel/panelSheets";
import { SemesterSelect, TeamFields } from "@/components/panel/teamForms";
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

/** A `<select>` of people or positions, by id. */
const OptionSelect = ({
  name,
  options,
  defaultValue,
}: {
  name: string;
  options: readonly Option[];
  defaultValue?: number;
}) => (
  <select name={name} className={nativeSelectClass} defaultValue={defaultValue}>
    {Arr.map(options, (option) => (
      <option key={option.id} value={option.id}>
        {option.name}
      </option>
    ))}
  </select>
);

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
}) => (
  <div className="flex flex-wrap justify-end gap-2">
    {member.canInvite && (
      <CommandSheet
        trigger={rowButton("Inviter", member)}
        triggerLabel="Inviter"
        title={`Inviter ${member.personName}`}
        description="En aktiveringslenke sendes til personens private e-post."
        action={inviteAccount}
        submitLabel="Send invitasjon"
      >
        <input name="personId" type="hidden" value={member.personId} />
      </CommandSheet>
    )}
    {member.canExtend && (
      <CommandSheet
        trigger={rowButton("Forleng", member)}
        triggerLabel="Forleng"
        title={`Forleng ${member.personName}`}
        description={`Medlemskapet slutter ${member.end.label}. Ingenting fortsetter av seg selv.`}
        action={extendMembership}
        submitLabel="Forleng"
        defaultOpen={opened}
      >
        <input type="hidden" name="id" value={member.id} />
        <Field name="end" label="Ny slutt">
          <SemesterSelect name="end" choices={member.extendChoices} />
        </Field>
      </CommandSheet>
    )}
    {member.canChange && (
      <CommandSheet
        trigger={rowButton("Endre", member)}
        triggerLabel="Endre"
        title={`Endre ${member.personName}`}
        description="Det gamle medlemskapet slutter før semesteret du velger, og et nytt begynner da."
        action={changeMembership}
        submitLabel="Endre"
      >
        <input type="hidden" name="id" value={member.id} />
        <Field name="from" label="Fra og med">
          <SemesterSelect name="from" choices={member.changeChoices} />
        </Field>
        <Field name="positionId" label="Stilling">
          <OptionSelect
            name="positionId"
            options={positions}
            defaultValue={member.positionId}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch name="leader" defaultChecked={member.leader} />
          Leder
        </label>
      </CommandSheet>
    )}
    {member.canEnd && (
      <CommandSheet
        trigger={rowButton("Avslutt", member)}
        triggerLabel="Avslutt"
        title={`Avslutt ${member.personName}`}
        description="Medlemskapet slutter før semesteret du velger."
        action={endMembership}
        submitLabel="Avslutt"
      >
        <input type="hidden" name="id" value={member.id} />
        <Field name="semester" label="Første semester uten medlemskap">
          <SemesterSelect name="semester" choices={member.endChoices} />
        </Field>
      </CommandSheet>
    )}
    {member.canCancel && (
      <CommandSheet
        trigger={rowButton("Kanseller", member)}
        triggerLabel="Kanseller"
        title={`Kanseller ${member.personName}`}
        description="Medlemskapet har ikke begynt, og fjernes helt."
        action={cancelMembership}
        submitLabel="Kanseller"
      >
        <input type="hidden" name="id" value={member.id} />
      </CommandSheet>
    )}
  </div>
);

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
                submitLabel="Legg til"
              >
                <input type="hidden" name="teamId" value={team.id} />
                <Field name="personId" label="Person">
                  <OptionSelect name="personId" options={people} />
                </Field>
                <Field name="positionId" label="Stilling">
                  <OptionSelect name="positionId" options={positions} />
                </Field>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Switch name="leader" />
                  Leder
                </label>
                <Field name="start" label="Fra og med">
                  <SemesterSelect name="start" choices={semesters} />
                </Field>
                <Field name="end" label="Til og med">
                  <SemesterSelect name="end" choices={semesters} optional />
                </Field>
              </CommandSheet>
            )}
            {canEdit && (
              <CommandSheet
                trigger={<Button variant="outline" size="sm" />}
                triggerLabel="Rediger team"
                title="Rediger team"
                action={saveTeam}
                submitLabel="Lagre"
              >
                <input type="hidden" name="id" value={team.id} />
                <TeamFields team={team} />
              </CommandSheet>
            )}
            {canDeactivate && team.active && (
              <CommandSheet
                trigger={<Button variant="outline" size="sm" />}
                triggerLabel="Deaktiver team"
                title="Deaktiver team"
                description="Et team slettes aldri. Et deaktivert team tar ikke imot nye medlemmer."
                action={deactivateTeam}
                submitLabel="Deaktiver"
              >
                <input type="hidden" name="id" value={team.id} />
              </CommandSheet>
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
