import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

export function OfflineTaskDialog({
  boardId,
  open,
  onOpenChange,
  onCreated,
}: {
  boardId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [error, setError] = useState("");
  const { data: repositories = [] } = useQuery({ queryKey: ["repositories"], queryFn: () => api.repositories.list() });
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError("");
    try {
      await api.tasks.create({
        title: title.trim(),
        description: description.trim() || undefined,
        board_id: boardId,
        repository_id: repositoryId || undefined,
      });
      setTitle("");
      setDescription("");
      onOpenChange(false);
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Create Local Task</DialogTitle>
            <DialogDescription>Create a Task, then open it and run it with Prime Agent.</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Task title"
            placeholder="What should Prime Agent do?"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
          <label className="block text-sm text-content-secondary">
            Workspace
            <select
              aria-label="Workspace"
              className="mt-1 w-full rounded-md border border-border bg-surface-primary px-3 py-2"
              value={repositoryId}
              onChange={(event) => setRepositoryId(event.target.value)}
            >
              <option value="">No workspace</option>
              {repositories.map((repository: any) => (
                <option key={repository.id} value={repository.id}>
                  {repository.name}
                </option>
              ))}
            </select>
          </label>
          <Textarea
            aria-label="Task description"
            placeholder="Details and acceptance checks"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={6}
          />
          {error && (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !title.trim()}>
              {saving ? "Creating…" : "Create Task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
