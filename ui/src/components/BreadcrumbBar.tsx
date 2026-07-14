import { Link } from "@/lib/router";
import { CircleHelp, Menu } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { heartbeatsApi } from "../api/heartbeats";
import { dashboardApi } from "../api/dashboard";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatCents } from "../lib/utils";
import { CostTape } from "./CostTape";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Fragment, useMemo } from "react";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";

type GlobalToolbarContext = { companyId: string | null; companyPrefix: string | null };

function GlobalToolbar({ context }: { context: GlobalToolbarContext }) {
  const { slots } = usePluginSlots({ slotTypes: ["globalToolbarButton"], companyId: context.companyId });
  const { launchers } = usePluginLaunchers({ placementZones: ["globalToolbarButton"], companyId: context.companyId, enabled: !!context.companyId });
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1 pl-2 empty:hidden">
      {slots.length > 0 ? (
        <PluginSlotOutlet slotTypes={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      ) : null}
      {launchers.length > 0 ? (
        <PluginLauncherOutlet placementZones={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      ) : null}
    </div>
  );
}

// Instrument strip: live working count + month-spend cost tape, on every
// in-company top bar. Reuses the dashboard/live-runs query caches.
function InstrumentStrip({ companyId }: { companyId: string }) {
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 10_000,
  });
  const { data: summary } = useQuery({
    queryKey: queryKeys.dashboard(companyId),
    queryFn: () => dashboardApi.summary(companyId),
    enabled: !!companyId,
  });
  const working = liveRuns?.length ?? 0;
  return (
    <div className="hidden items-center gap-2 md:flex">
      <span className="inline-flex items-center gap-1.5 rounded-[3px] border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground">
        <span className="relative flex h-1.5 w-1.5">
          {working > 0 && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-running opacity-70" />
          )}
          <span
            className={cn(
              "relative inline-flex h-1.5 w-1.5 rounded-full",
              working > 0 ? "bg-status-running" : "bg-muted-foreground/40",
            )}
          />
        </span>
        {working} working
      </span>
      {summary ? (
        <span className="inline-flex items-center gap-1.5 rounded-[3px] border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground">
          mo <CostTape text={formatCents(summary.costs.monthSpendCents)} className="text-primary" />
        </span>
      ) : null}
    </div>
  );
}

export function BreadcrumbBar({ onOpenGuide }: { onOpenGuide?: () => void } = {}) {
  const { breadcrumbs, mobileToolbar } = useBreadcrumbs();
  const { toggleSidebar, isMobile } = useSidebar();
  const { selectedCompanyId, selectedCompany } = useCompany();

  const globalToolbarSlotContext = useMemo(
    () => ({
      companyId: selectedCompanyId ?? null,
      companyPrefix: selectedCompany?.issuePrefix ?? null,
    }),
    [selectedCompanyId, selectedCompany?.issuePrefix],
  );

  const globalToolbarSlots = <GlobalToolbar context={globalToolbarSlotContext} />;
  const rightSide = (
    <div className="ml-auto flex items-center gap-2 shrink-0 pl-2">
      {selectedCompanyId ? <InstrumentStrip companyId={selectedCompanyId} /> : null}
      {globalToolbarSlots}
      {onOpenGuide ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onOpenGuide}
          aria-label="Open the ValAdrien OS guide"
          title="Guide & help"
        >
          <CircleHelp className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );

  if (isMobile && mobileToolbar) {
    return (
      <div className="border-b border-border px-2 h-12 shrink-0 flex items-center">
        {mobileToolbar}
      </div>
    );
  }

  if (breadcrumbs.length === 0) {
    return (
      <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center">
        {rightSide}
      </div>
    );
  }

  const menuButton = isMobile && (
    <Button
      variant="ghost"
      size="icon-sm"
      className="mr-2 shrink-0"
      onClick={toggleSidebar}
      aria-label="Open sidebar"
    >
      <Menu className="h-5 w-5" />
    </Button>
  );

  // Single breadcrumb = page title (uppercase)
  if (breadcrumbs.length === 1) {
    return (
      <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center">
        {menuButton}
        <div className="min-w-0 overflow-hidden flex-1">
          {breadcrumbs[0].leading ? (
            <h1 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider">
              <span className="flex shrink-0 items-center">{breadcrumbs[0].leading}</span>
              <span className="truncate">{breadcrumbs[0].label}</span>
            </h1>
          ) : (
            <h1 className="text-sm font-semibold uppercase tracking-wider truncate">
              {breadcrumbs[0].label}
            </h1>
          )}
        </div>
        {rightSide}
      </div>
    );
  }

  // Multiple breadcrumbs = breadcrumb trail
  return (
    <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center">
      {menuButton}
      <div className="min-w-0 overflow-hidden flex-1">
        <Breadcrumb className="min-w-0 overflow-hidden">
          <BreadcrumbList className="flex-nowrap">
            {breadcrumbs.map((crumb, i) => {
              const isLast = i === breadcrumbs.length - 1;
              return (
                <Fragment key={i}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem className={isLast ? "min-w-0" : "shrink-0"}>
                    {isLast || !crumb.href ? (
                      crumb.leading ? (
                        <BreadcrumbPage className="flex min-w-0 items-center gap-1.5">
                          <span className="flex shrink-0 items-center">{crumb.leading}</span>
                          <span className="truncate">{crumb.label}</span>
                        </BreadcrumbPage>
                      ) : (
                        <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                      )
                    ) : (
                      <BreadcrumbLink asChild>
                        {crumb.leading ? (
                          <Link to={crumb.href} className="flex items-center gap-1.5">
                            <span className="flex shrink-0 items-center">{crumb.leading}</span>
                            <span className="truncate">{crumb.label}</span>
                          </Link>
                        ) : (
                          <Link to={crumb.href}>{crumb.label}</Link>
                        )}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {rightSide}
    </div>
  );
}
