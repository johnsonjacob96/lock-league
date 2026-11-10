import datetime as dt
import unittest
import json
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock
import run as runner
from run import CT, due_dates, message_text, schema

class ScheduleTests(unittest.TestCase):
    def due(self, instant, state=None, start='2026-10-12'):
        return due_dates(dt.datetime.fromisoformat(instant),start,state or {})

    def test_extraction_schema_limits_directions_to_app_contract(self):
        sides=schema()['properties']['legs']['items']['properties']['side']['enum']
        self.assertEqual(set(sides), {'over','under','atleast','yes','spread','moneyline'})
        self.assertNotIn('win',sides)

    def test_before_due_and_first_run(self):
        self.assertEqual(self.due('2026-10-12T19:29:59-05:00'), [])
        self.assertEqual(self.due('2026-10-12T19:30:00-05:00'), ['2026-10-12'])

    def test_no_tuesday_run_after_monday_success(self):
        self.assertEqual(self.due('2026-10-13T20:00:00-05:00', {'2026-10-12':{'status':'saved'}}), [])

    def test_catchup_after_sleep(self):
        self.assertEqual(self.due('2026-10-13T09:00:00-05:00'), ['2026-10-12'])

    def test_second_attempt_waits_an_hour(self):
        stamp=dt.datetime.fromisoformat('2026-10-12T19:30:00-05:00').timestamp()
        state={'2026-10-12':{'status':'not_found','attempts':1,'last_attempt':stamp}}
        self.assertEqual(self.due('2026-10-12T20:29:00-05:00',state), [])
        self.assertEqual(self.due('2026-10-12T20:30:00-05:00',state), ['2026-10-12'])

    def test_max_attempts_and_review_never_retry(self):
        for entry in ({'attempts':2,'status':'error'},{'attempts':1,'status':'needs_review'},
                      {'status':'already_exists'}):
            self.assertEqual(self.due('2026-10-12T22:00:00-05:00',{'2026-10-12':entry}), [])

    def test_dst_uses_central_not_machine_time(self):
        self.assertEqual(self.due('2026-11-03T01:29:00+00:00',start='2026-11-02'), [])
        self.assertEqual(self.due('2026-11-03T01:30:00+00:00',start='2026-11-02'), ['2026-11-02'])

    def test_never_import_before_install(self):
        self.assertEqual(self.due('2026-10-12T09:00:00-05:00'), [])

    def test_attributed_string_and_plain_text(self):
        text='Jalon Daniels ATTD +270'
        blob=b'headerNSString\x01\x01+'+bytes([len(text)])+text.encode()+b'\x02iI'
        self.assertEqual(message_text({'text':None,'attributedBody':blob}),text)
        self.assertEqual(message_text({'text':'Over 5.5','attributedBody':None}),'Over 5.5')

    def test_long_string_unicode(self):
        value=('A'+chr(233))*100
        b=value.encode()
        blob=b'NSString\x01\x01+\x81'+len(b).to_bytes(2,'little')+b
        self.assertEqual(message_text({'text':None,'attributedBody':blob}),value)

    def test_macos_object_references_between_class_and_string(self):
        value='Jalon Daniels ATTD +270'
        blob=b'NSString\x01\x94\x84\x01+'+bytes([len(value)])+value.encode()+b'\x86\x84'
        self.assertEqual(message_text({'text':None,'attributedBody':blob}),value)

class ImageWaitTests(unittest.TestCase):
    def test_only_missing_images_are_reopened_and_waits_expire(self):
        state = {
            '2026-11-05': {'status':'missed','attempts':2,'note':'No images yet'},
            '2026-11-02': {'status':'needs_review','attempts':1,'note':'Unknown owner'},
            '2026-10-29': {'status':'waiting_for_images','attempts':0},
            '2026-10-26': {'status':'saved'},
            '2026-10-22': {'status':'missed','attempts':2,'note':'No placed receipt'},
        }
        runner.refresh_image_waits(state,dt.datetime.fromisoformat('2026-11-09T21:00:00-06:00'))
        self.assertEqual(state['2026-11-05']['status'],'waiting_for_images')
        self.assertEqual(state['2026-11-05']['attempts'],0)
        self.assertEqual(state['2026-11-02']['status'],'needs_review')
        self.assertEqual(state['2026-10-29']['status'],'missed')
        self.assertEqual(state['2026-10-26']['status'],'saved')
        self.assertEqual(state['2026-10-22']['status'],'missed')

    def test_no_image_ticks_skip_remote_work_then_resume_once_synced(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'config.json').write_text(json.dumps({'start_date':'2026-10-12','chat_identifier':'league'}))
            date=dt.datetime.now(CT).date().isoformat()
            db=MagicMock();db.execute.return_value.fetchone.return_value={'ROWID':67}
            with patch.object(runner,'RUNTIME',root), patch('sys.argv',['run.py']), \
                 patch.object(runner,'due_dates',return_value=[date]), \
                 patch.object(runner,'connect_readonly') as connect, \
                 patch.object(runner,'resolve_senders'), patch.object(runner,'notify'), \
                 patch.object(runner,'has_local_image',return_value=False) as available, \
                 patch.object(runner,'run_date',return_value={'status':'saved','id':'test'}) as run_date, \
                 patch.object(runner,'bridge') as bridge:
                connect.return_value.__enter__.return_value=db
                for _ in range(3):runner.main()
                run_date.assert_not_called();bridge.assert_not_called()
                entry=json.loads((root/'state.json').read_text())[date]
                self.assertEqual(entry['status'],'waiting_for_images');self.assertEqual(entry['attempts'],0)
                available.return_value=True
                runner.main();run_date.assert_called_once()
                self.assertEqual(json.loads((root/'state.json').read_text())[date]['status'],'saved')

    def test_image_check_restricts_chat_day_type_and_download(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);attachments=home/'Library/Messages/Attachments';attachments.mkdir(parents=True)
            image=attachments/'slip.jpg';image.write_bytes(b'fixture')
            db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
            db.executescript("""CREATE TABLE chat(ROWID INTEGER,chat_identifier TEXT,display_name TEXT);
                CREATE TABLE message(ROWID INTEGER,date INTEGER,associated_message_type INTEGER);
                CREATE TABLE attachment(ROWID INTEGER,filename TEXT,mime_type TEXT);
                CREATE TABLE message_attachment_join(message_id INTEGER,attachment_id INTEGER);
                CREATE TABLE chat_message_join(message_id INTEGER,chat_id INTEGER);""")
            stamp=int((dt.datetime.fromisoformat('2026-11-09T18:00:00-06:00').timestamp()-runner.APPLE_EPOCH)*1e9)
            db.execute('INSERT INTO chat VALUES(67,?,?)',('league','Lock League'))
            db.execute('INSERT INTO message VALUES(1,?,0)',(stamp,))
            db.execute('INSERT INTO attachment VALUES(1,?,?)',(str(image),'image/jpeg'))
            db.execute('INSERT INTO message_attachment_join VALUES(1,1)')
            db.execute('INSERT INTO chat_message_join VALUES(1,67)')
            with patch.object(runner.Path,'home',return_value=home):
                self.assertTrue(runner.has_local_image(db,'2026-11-09','league'))
                self.assertFalse(runner.has_local_image(db,'2026-11-09','another-chat'))
                self.assertFalse(runner.has_local_image(db,'2026-11-05','league'))
                db.execute("UPDATE attachment SET mime_type='video/mp4'")
                self.assertFalse(runner.has_local_image(db,'2026-11-09','league'))
                db.execute("UPDATE attachment SET mime_type='image/jpeg'")
                db.execute('UPDATE message SET associated_message_type=2000')
                self.assertFalse(runner.has_local_image(db,'2026-11-09','league'))
                db.execute('UPDATE message SET associated_message_type=0')
                image.unlink()
                self.assertFalse(runner.has_local_image(db,'2026-11-09','league'))

if __name__ == '__main__':
    unittest.main()
