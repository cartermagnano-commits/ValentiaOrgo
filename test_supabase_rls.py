"""
test_supabase_rls.py — Confirms Row Level Security actually isolates users.

Run against a REAL Supabase project with supabase/schema.sql applied and
email confirmations disabled (SUPABASE_SETUP.md, step 3):

    TEST_SUPABASE_URL=https://your-project.supabase.co \
    TEST_SUPABASE_ANON_KEY=your-anon-key \
    python test_supabase_rls.py

Skipped (not failed) when those env vars are unset. See
docs/superpowers/specs/2026-09-04-user-profiles-design.md, Testing.

Creates two throwaway accounts, has one write rows (a project AND a
chemistry_files row — the table that holds all real user content), then
asserts the other account's token cannot read, update, or delete them, that
neither can write to usage_events (service-role only), and that each
account's signup trigger created exactly its own profiles row.

Also asserts that deleting a project UNGROUPS its files (project_id -> null)
rather than cascade-deleting them, which is what the frontend promises the
user ("Its chats are kept in Chats") and what supabase/schema.sql's
chemistry_files_project_id_fkey migration exists to guarantee.

Test accounts accumulate in auth.users — delete them from the Supabase
dashboard after running. Not automated here; out of scope for a one-time
verification gate.
"""

import os
import sys
import uuid

import httpx

BASE = os.environ.get("TEST_SUPABASE_URL", "").rstrip("/")
ANON_KEY = os.environ.get("TEST_SUPABASE_ANON_KEY", "")

if not BASE or not ANON_KEY:
    print("SKIP  set TEST_SUPABASE_URL and TEST_SUPABASE_ANON_KEY to run this suite")
    sys.exit(0)

failures: list[str] = []


def check(name: str, ok: bool, detail: str = ""):
    if ok:
        print(f"PASS  {name}")
    else:
        failures.append(name)
        print(f"FAIL  {name}  {detail}")


def sign_up(email: str, password: str) -> tuple[str, str]:
    resp = httpx.post(
        f"{BASE}/auth/v1/signup",
        json={"email": email, "password": password},
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
    )
    resp.raise_for_status()
    data = resp.json()
    return data["access_token"], data["user"]["id"]


def rest(token: str) -> httpx.Client:
    return httpx.Client(
        base_url=f"{BASE}/rest/v1",
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )


stamp = uuid.uuid4().hex[:8]
token_a, user_a = sign_up(f"rls-test-a-{stamp}@example.com", "test-password-123!")
token_b, user_b = sign_up(f"rls-test-b-{stamp}@example.com", "test-password-123!")

with rest(token_a) as client_a, rest(token_b) as client_b:
    created = client_a.post("/projects", json={
        "user_id": user_a, "name": "RLS test project", "description": "",
    })
    check("user A can create their own project", created.status_code == 201, created.text)
    project_a_id = created.json()[0]["id"]

    leaked = client_b.get("/projects", params={"id": f"eq.{project_a_id}"})
    check("user B's read of user A's project returns nothing",
          leaked.status_code == 200 and leaked.json() == [], leaked.text)

    blocked_update = client_b.patch(
        "/projects", params={"id": f"eq.{project_a_id}"}, json={"name": "hijacked"})
    reread = client_a.get("/projects", params={"id": f"eq.{project_a_id}"})
    check("user B's update of user A's project has no effect",
          reread.status_code == 200 and reread.json()[0]["name"] == "RLS test project",
          f"update_status={blocked_update.status_code} reread={reread.text}")

    blocked_delete = client_b.delete("/projects", params={"id": f"eq.{project_a_id}"})
    still_there = client_a.get("/projects", params={"id": f"eq.{project_a_id}"})
    check("user B's delete of user A's project has no effect",
          still_there.status_code == 200 and len(still_there.json()) == 1,
          f"delete_status={blocked_delete.status_code}")

    created_file = client_a.post("/chemistry_files", json={
        "user_id": user_a, "project_id": project_a_id,
        "title": "RLS test chat", "type": "chat", "content": {},
    })
    check("user A can create their own chemistry file",
          created_file.status_code == 201, created_file.text)
    file_a_id = created_file.json()[0]["id"]

    leaked_file = client_b.get("/chemistry_files", params={"id": f"eq.{file_a_id}"})
    check("user B's read of user A's chemistry file returns nothing",
          leaked_file.status_code == 200 and leaked_file.json() == [], leaked_file.text)

    blocked_file_update = client_b.patch(
        "/chemistry_files", params={"id": f"eq.{file_a_id}"}, json={"title": "hijacked"})
    file_reread = client_a.get("/chemistry_files", params={"id": f"eq.{file_a_id}"})
    check("user B's update of user A's chemistry file has no effect",
          file_reread.status_code == 200 and file_reread.json()[0]["title"] == "RLS test chat",
          f"update_status={blocked_file_update.status_code} reread={file_reread.text}")

    blocked_file_delete = client_b.delete("/chemistry_files", params={"id": f"eq.{file_a_id}"})
    file_still_there = client_a.get("/chemistry_files", params={"id": f"eq.{file_a_id}"})
    check("user B's delete of user A's chemistry file has no effect",
          file_still_there.status_code == 200 and len(file_still_there.json()) == 1,
          f"delete_status={blocked_file_delete.status_code}")

    # Deleting a project must UNGROUP its files, never delete them — the
    # frontend tells the user "Its chats are kept in Chats". Fails loudly
    # against the original "on delete cascade" FK (the re-read comes back
    # empty); passes only once schema.sql's set-null migration has been
    # applied to this project.
    dropped_project = client_a.delete("/projects", params={"id": f"eq.{project_a_id}"})
    orphaned = client_a.get("/chemistry_files", params={"id": f"eq.{file_a_id}"})
    orphaned_rows = orphaned.json() if orphaned.status_code == 200 else []
    check("deleting a project keeps its files, ungrouped (project_id set null, not cascade)",
          len(orphaned_rows) == 1 and orphaned_rows[0]["project_id"] is None,
          f"delete_status={dropped_project.status_code} reread={orphaned.text}")

    client_a.delete("/chemistry_files", params={"id": f"eq.{file_a_id}"})

    spoofed = client_a.post("/usage_events", json={"user_id": user_a, "endpoint": "react"})
    check("a user token cannot insert into usage_events (service-role only)",
          spoofed.status_code in (401, 403), spoofed.text)

    own_profile = client_a.get("/profiles", params={"id": f"eq.{user_a}"})
    check("signup's trigger created a profile row for user A",
          own_profile.status_code == 200 and len(own_profile.json()) == 1, own_profile.text)

    others_profile = client_b.get("/profiles", params={"id": f"eq.{user_a}"})
    check("user B's read of user A's profile returns nothing",
          others_profile.status_code == 200 and others_profile.json() == [], others_profile.text)

    own_profile_b = client_b.get("/profiles", params={"id": f"eq.{user_b}"})
    check("signup's trigger created a profile row for user B",
          own_profile_b.status_code == 200 and len(own_profile_b.json()) == 1, own_profile_b.text)

    others_profile_from_a = client_a.get("/profiles", params={"id": f"eq.{user_b}"})
    check("user A's read of user B's profile returns nothing",
          others_profile_from_a.status_code == 200 and others_profile_from_a.json() == [], others_profile_from_a.text)

    # The project and its file are already gone (the set-null check above
    # deleted the project; the file was deleted right after). This is a
    # belt-and-braces sweep for a run that failed before reaching those.
    client_a.delete("/chemistry_files", params={"id": f"eq.{file_a_id}"})
    client_a.delete("/projects", params={"id": f"eq.{project_a_id}"})

print(f"\n{len(failures)} failing" if failures else "\nAll checks passed")
sys.exit(1 if failures else 0)
