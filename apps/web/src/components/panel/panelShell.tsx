import { Link, useRouterState } from "@tanstack/react-router";
import { Array as Arr } from "effect";
import {
  BuildingIcon,
  CalendarDaysIcon,
  ChartColumnIcon,
  ExternalLinkIcon,
  GraduationCapIcon,
  LayoutDashboardIcon,
  PartyPopperIcon,
  PlugIcon,
  ShieldCheckIcon,
  SigmaIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { actorLabel } from "@/lib/actorLabel";
import { sectionOfPath } from "@/lib/panelSections";
import type { NavigationGroup, SectionKey } from "@/lib/panelSections";
import type { ActorSummary } from "@/server/shell";

const SECTION_ICONS: Readonly<Record<SectionKey, LucideIcon>> = {
  admins: ShieldCheckIcon,
  departments: BuildingIcon,
  fieldsOfStudy: GraduationCapIcon,
  impact: ChartColumnIcon,
  integrations: PlugIcon,
  overview: LayoutDashboardIcon,
  people: UserRoundIcon,
  semesters: CalendarDaysIcon,
  socialEvents: PartyPopperIcon,
  teams: UsersIcon,
};

const PanelSidebar = ({
  actor,
  navigation,
}: {
  actor: ActorSummary;
  navigation: readonly NavigationGroup[];
}) => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const current = sectionOfPath(pathname)?.key;
  const { setOpenMobile } = useSidebar();

  const closeMobileSidebar = () => {
    setOpenMobile(false);
  };

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Kontrollpanel"
              onClick={closeMobileSidebar}
              render={<Link to="/kontrollpanel" />}
            >
              <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                <SigmaIcon />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Vektorprogrammet</span>
                <span className="truncate text-xs">Kontrollpanel</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent role="navigation" aria-label="Kontrollpanel">
        {Arr.map(navigation, (group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {Arr.map(group.items, (item) => {
                  const Icon = SECTION_ICONS[item.key];

                  return (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton
                        isActive={current === item.key}
                        tooltip={item.label}
                        onClick={closeMobileSidebar}
                        render={
                          <Link to={item.to} activeOptions={{ exact: true }} />
                        }
                      >
                        <Icon />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Min side"
              onClick={closeMobileSidebar}
              render={<Link to="/min-side" />}
            >
              <UserRoundIcon />
              <span>Min side</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Til nettsiden"
              onClick={closeMobileSidebar}
              render={<Link to="/" />}
            >
              <ExternalLinkIcon />
              <span>Til nettsiden</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <p className="text-sidebar-foreground/70 px-2 text-xs group-data-[collapsible=icon]:hidden">
          Innlogget som {actorLabel(actor)}
        </p>
      </SidebarFooter>
    </Sidebar>
  );
};

const PanelHeader = () => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const section = sectionOfPath(pathname);

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-vertical:h-4" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            {section === undefined || section.key !== "overview" ? (
              <BreadcrumbLink render={<Link to="/kontrollpanel" />}>
                Kontrollpanel
              </BreadcrumbLink>
            ) : (
              <BreadcrumbPage>Kontrollpanel</BreadcrumbPage>
            )}
          </BreadcrumbItem>
          {section !== undefined && section.key !== "overview" && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{section.label}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
    </header>
  );
};

/**
 * The control panel's shell: a sidebar of the sections the actor may use (collapsible to icons, an off-canvas
 * panel on a phone), a header with the sidebar toggle and breadcrumbs, and the page in the main area.
 */
export const PanelShell = ({
  actor,
  navigation,
  children,
}: {
  actor: ActorSummary;
  navigation: readonly NavigationGroup[];
  children: ReactNode;
}) => (
  <TooltipProvider>
    <div className="text-foreground">
      <SidebarProvider>
        <PanelSidebar actor={actor} navigation={navigation} />
        <SidebarInset>
          <PanelHeader />
          <div className="flex flex-1 flex-col gap-6 p-4 pt-2 md:p-6 md:pt-2">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  </TooltipProvider>
);
