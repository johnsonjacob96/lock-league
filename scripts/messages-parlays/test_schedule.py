import datetime as dt
import unittest
from run import CT, due_dates, message_text

class ScheduleTests(unittest.TestCase):
    def due(self, instant, state=None, start='2026-10-12'):
        return due_dates(dt.datetime.fromisoformat(instant),start,state or {})

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

if __name__ == '__main__':
    unittest.main()
