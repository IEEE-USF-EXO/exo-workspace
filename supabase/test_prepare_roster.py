"""Run with: python -m unittest discover -s supabase -p test_prepare_roster.py"""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepare_roster', Path(__file__).with_name('prepare-roster.py'))
roster = importlib.util.module_from_spec(spec)
spec.loader.exec_module(roster)


class Sheet:
    def __init__(self, rows):
        self.rows = rows

    def iter_rows(self, values_only=True):
        return iter(self.rows)


def workbook(members, teams):
    return {'Members': Sheet([['header']] + members), 'Teams': Sheet([['header']] + teams)}


def member(email, name='Person', team='Team', child='', login='person'):
    return ['', email, name, team, child, '', login, '', '']


class RosterTests(unittest.TestCase):
    def test_duplicate_rows_and_email_case_do_not_duplicate_approvals(self):
        records, _, people = roster.prepare(workbook(
            [member(' Account@example.com '), member('account@example.com')], [['Team', '']]))
        self.assertEqual(len(records), 1)
        self.assertEqual(len(people), 1)

    def test_two_google_aliases_keep_both_emails_for_one_person(self):
        records, _, people = roster.prepare(workbook(
            [member('account@gmail.com'), member('account@organization.example')], [['Team', '']]))
        self.assertEqual(len(records), 2)
        self.assertEqual(len(people), 1)
        self.assertEqual(len(people[0]['emails']), 2)

    def test_subteam_does_not_also_grant_parent_or_siblings(self):
        records, _, _ = roster.prepare(workbook([member('a@example.com', child='Leaf')],
                                               [['Team', ''], ['Team', 'Leaf'], ['Team', 'Sibling']]))
        self.assertEqual([(r['team'], r['subteam']) for r in records], [('Team', 'Leaf')])

    def test_cross_team_member_keeps_both_explicit_groups(self):
        records, review, _ = roster.prepare(workbook([member('a@example.com', child='Leaf')],
                                  [['Team', ''], ['Other', ''], ['Other', 'Leaf']]))
        self.assertEqual({(r['team'], r['subteam']) for r in records}, {('Team', ''), ('Other', 'Leaf')})
        self.assertEqual(len(review), 1)

    def test_missing_identity_and_ambiguous_group_are_excluded(self):
        records, review, _ = roster.prepare(workbook(
            [member(''), member('a@example.com', name=''), member('b@example.com', child='Leaf')],
            [['Team', ''], ['Other', 'Leaf'], ['Third', 'Leaf']]))
        self.assertFalse(records)
        self.assertEqual(len(review), 3)

    def test_sql_escapes_source_values(self):
        sql = roster.seed_sql([dict(email='a@example.com', team="Member's team", subteam='', source_row=2)])
        self.assertIn("'Member''s team'", sql)
        self.assertIn('on conflict(email, team_id) do nothing', sql)
        self.assertIn('apply_roster_memberships(account_id)', sql)
        self.assertNotIn('insert into public.leadership_assignments', sql)

    def test_import_and_verification_do_not_depend_on_temporary_tables(self):
        sql = roster.seed_sql([dict(email='a@example.com', team='Team', subteam='', source_row=2)])
        self.assertNotRegex(sql.lower(), r'create\s+(?:temporary|temp)\s+table')
        self.assertNotIn('exo_roster_input', sql)
        self.assertIn('do $import$', sql)
        report = sql.split('$import$;', 1)[1]
        self.assertIn('with input(email, parent_name, child_name, source_row) as (values', report)


if __name__ == '__main__':
    unittest.main()
