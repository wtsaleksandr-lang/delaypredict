import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff, KeyRound, Trash2 } from "lucide-react";

interface KeyMeta {
  key: string;
  label: string;
  description: string;
  type: "secret" | "toggle" | "url";
  group: string;
}

interface SettingsResponse {
  keys: KeyMeta[];
  values: Record<
    string,
    { set: boolean; source: "settings" | "env" | "none"; preview: string }
  >;
}

function SourceBadge({ source }: { source: "settings" | "env" | "none" }) {
  if (source === "settings") {
    return (
      <Badge className="bg-emerald-600 text-white text-[10px] font-bold">
        Saved
      </Badge>
    );
  }
  if (source === "env") {
    return (
      <Badge variant="secondary" className="text-[10px]">
        From env
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-amber-500 border-amber-500/40">
      Not set
    </Badge>
  );
}

function KeyRow({
  meta,
  state,
}: {
  meta: KeyMeta;
  state: { set: boolean; source: "settings" | "env" | "none"; preview: string };
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [show, setShow] = useState(false);
  const [value, setValue] = useState("");

  const save = useMutation({
    mutationFn: async (v: string | null) => {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: meta.key, value: v }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/settings"] });
      setEditing(false);
      setValue("");
      toast({ title: `${meta.label} saved`, description: "Restart not required for this key — takes effect on next call." });
    },
    onError: (err: Error) => {
      toast({
        title: "Save failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const inputType = meta.type === "secret" && !show ? "password" : "text";

  return (
    <div className="space-y-1.5 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Label className="text-sm font-medium text-foreground">{meta.label}</Label>
            <SourceBadge source={state.source} />
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{meta.description}</p>
          <code className="text-[10px] text-muted-foreground/70 block mt-0.5">{meta.key}</code>
        </div>
      </div>

      {editing ? (
        <div className="flex gap-1.5 items-center">
          <Input
            type={inputType}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={meta.type === "toggle" ? "true / false" : `Paste ${meta.label}`}
            className="h-8 text-sm flex-1"
            autoFocus
          />
          {meta.type === "secret" && (
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => setShow((s) => !s)}
              className="h-8 px-2"
            >
              {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => save.mutate(value)}
            disabled={save.isPending || !value.trim()}
            className="h-8"
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setValue("");
            }}
            className="h-8"
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <code className="text-xs text-muted-foreground tabular-nums">
            {state.set ? state.preview : "—"}
          </code>
          <div className="flex gap-1">
            {state.set && state.source === "settings" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => save.mutate(null)}
                disabled={save.isPending}
                className="h-7 px-2 text-muted-foreground hover:text-red-500"
                title="Clear saved value (env fallback will resume if set)"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
              className="h-7 text-xs"
            >
              {state.set ? "Change" : "Set"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SecretsButton() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery<SettingsResponse>({
    queryKey: ["/api/settings"],
    enabled: open,
  });

  const grouped: Record<string, KeyMeta[]> = {};
  (data?.keys ?? []).forEach((k) => {
    if (!grouped[k.group]) grouped[k.group] = [];
    grouped[k.group].push(k);
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground hover:text-foreground gap-1.5 h-8"
          data-testid="btn-secrets"
        >
          <KeyRound className="w-3.5 h-3.5" />
          API keys & secrets
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>API keys &amp; secrets</DialogTitle>
          <DialogDescription>
            Saved values are stored in <code>data/app-settings.json</code> on the
            server and override environment variables. Existing env vars
            stay as fallback. Most keys take effect on the next API call without a restart.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <div className="text-sm text-muted-foreground py-4">Loading…</div>}

        {data && (
          <div className="space-y-1">
            {Object.entries(grouped).map(([group, keys]) => (
              <div key={group}>
                <div className="sticky top-0 bg-background/95 backdrop-blur py-1.5 z-10">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    {group}
                  </h3>
                </div>
                <Separator />
                {keys.map((k) => (
                  <KeyRow
                    key={k.key}
                    meta={k}
                    state={data.values[k.key] ?? { set: false, source: "none", preview: "" }}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
