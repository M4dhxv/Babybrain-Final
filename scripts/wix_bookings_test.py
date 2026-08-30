"""
Wix Bookings API Integration — Console-Only Test
=================================================
Tests the full Wix Bookings flow and prints results to console.
No JSON file is saved.

Steps tested:
  1. Fetch services catalog
  2. Fetch resources (staff)
  3. Check available time slots
  4. Create a booking
"""
import os
import sys
import json
import requests
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv


# Fix for Windows console UTF-8 encoding (prevents emoji crash)
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

# ==========================================
# 1. CONFIGURATION & CREDENTIALS
# ==========================================
# Real secrets live in .env.local (gitignored) — never .env.example, which is
# a committed template and must stay free of live tokens.
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../.env.local"))
WIX_ACCESS_TOKEN = os.getenv("WIX_ACCESS_TOKEN", "")
WIX_SITE_ID      = os.getenv("WIX_SITE_ID", "")

if not WIX_ACCESS_TOKEN or not WIX_SITE_ID:
    print("❌ Missing credentials! Set WIX_ACCESS_TOKEN and WIX_SITE_ID in your .env.local file.")
    exit(1)

HEADERS = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {WIX_ACCESS_TOKEN}",
    "wix-site-id": WIX_SITE_ID
}

# Test contact used for the booking this script creates — override via env
# so the same script can be pointed at a different test identity without
# editing code.
TEST_CONTACT = {
    "firstName": os.getenv("WIX_TEST_FIRST_NAME", "Test"),
    "lastName": os.getenv("WIX_TEST_LAST_NAME", "User"),
    "email": os.getenv("WIX_TEST_EMAIL", "test.user@example.com"),
    "phone": os.getenv("WIX_TEST_PHONE", "+15550199000"),
}

# ==========================================
# 2. FETCH: Services
# ==========================================
def fetch_services():
    print("Fetching services from Wix...")
    url = "https://www.wixapis.com/bookings/v2/services/query"
    payload = {"query": {"paging": {"limit": 50}}}
    response = requests.post(url, headers=HEADERS, json=payload)

    if response.status_code == 200:
        services = response.json().get("services", [])
        print(f"✅ Found {len(services)} service(s).")
        for s in services:
            print(f"   - [{s.get('type')}] {s.get('name')}  (ID: {s.get('id')})")
        return services
    else:
        print(f"❌ Failed to fetch services ({response.status_code}): {response.text}")
        return None

# ==========================================
# 3. FETCH: Resources (Staff)
# ==========================================
def fetch_resources():
    print("\nFetching resources (staff)...")
    url = "https://www.wixapis.com/bookings/v2/resources/query"
    response = requests.post(url, headers=HEADERS, json={"query": {}})

    if response.status_code == 200:
        resources = response.json().get("resources", [])
        print(f"✅ Found {len(resources)} resource(s).")
        for r in resources:
            print(f"   - {r.get('name')}  (ID: {r.get('id')})  Bookable: {r.get('bookable')}")
        return resources
    else:
        print(f"❌ Failed to fetch resources ({response.status_code}): {response.text}")
        return None

# ==========================================
# 4. CHECK: Available Time Slots
# ==========================================
def check_availability(service_id):
    print(f"\nChecking availability for Service ID: {service_id}...")
    url = "https://www.wixapis.com/_api/service-availability/v2/time-slots"
    now = datetime.now(timezone.utc)

    payload = {
        "serviceId": service_id,
        "fromLocalDate": now.strftime('%Y-%m-%dT%H:%M:%S'),
        "toLocalDate": (now + timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%S'),
        "timezone": "UTC"
    }
    response = requests.post(url, headers=HEADERS, json=payload)

    if response.status_code == 200:
        data = response.json()
        all_slots = data.get("timeSlots", [])
        bookable_slots = [s for s in all_slots if s.get("bookable")]
        print(f"✅ Found {len(all_slots)} total slot(s), {len(bookable_slots)} bookable.")
        if bookable_slots:
            first = bookable_slots[0]
            print(f"   - Next available: {first.get('localStartDate')} → {first.get('localEndDate')}")
        return bookable_slots
    else:
        print(f"❌ Failed to check availability ({response.status_code}): {response.text}")
        return None

# ==========================================
# 5. WRITE: Create Booking
# ==========================================
def create_booking(slot, resource_id):
    print(f"\nCreating booking for slot: {slot.get('localStartDate')}...")
    url = "https://www.wixapis.com/_api/bookings-service/v2/bookings"

    loc_map = {"BUSINESS": "OWNER_BUSINESS", "CUSTOM": "OWNER_CUSTOM"}
    raw_loc = slot.get("location", {}).get("locationType", "BUSINESS")
    mapped_loc = loc_map.get(raw_loc, raw_loc)

    payload = {
        "booking": {
            "bookedEntity": {
                "slot": {
                    "startDate": slot["localStartDate"],
                    "endDate": slot["localEndDate"],
                    "serviceId": slot["serviceId"],
                    "scheduleId": slot.get("scheduleId"),
                    "resource": {"id": resource_id},
                    "location": {"locationType": mapped_loc}
                }
            },
            "numberOfParticipants": 1,
            "contactDetails": TEST_CONTACT
        },
        "flowControlSettings": {
            "skipBusinessConfirmation": True   # Makes booking CONFIRMED, visible in dashboard
        }
    }

    response = requests.post(url, headers=HEADERS, json=payload)

    if response.status_code in (200, 201):
        booking = response.json().get("booking", {})
        print("✅ Booking created successfully!")
        print(f"   - Booking ID : {booking.get('id')}")
        print(f"   - Status     : {booking.get('status')}")
        print(f"   - Service    : {booking.get('bookedEntity', {}).get('title')}")
        print(f"   - Start      : {booking.get('adjustedStart', {}).get('localDate')}")
        print(f"   - End        : {booking.get('adjustedEnd', {}).get('localDate')}")
        return booking
    else:
        print(f"❌ Failed to create booking ({response.status_code}): {response.text}")
        return None

# ==========================================
# 6. MAIN EXECUTION FLOW
# ==========================================
if __name__ == "__main__":
    print("--- STARTING WIX API INTEGRATION TEST ---\n")

    # Step 1: Fetch services
    all_services = fetch_services()
    if not all_services:
        exit(1)

    appointment_services = [s for s in all_services if s.get("type") == "APPOINTMENT"]
    if not appointment_services:
        print("\n⚠️  No APPOINTMENT services found.")
        exit(1)

    target_service = appointment_services[0]
    print(f"\nTargeting: {target_service.get('name')}")

    # Step 2: Fetch resources
    all_resources = fetch_resources()
    if not all_resources:
        exit(1)

    bookable_resources = [r for r in all_resources if r.get("bookable")]
    if not bookable_resources:
        print("\n⚠️  No bookable resources found.")
        exit(1)

    target_resource = bookable_resources[0]
    print(f"\nUsing resource: {target_resource.get('name')}")

    # Step 3: Check availability
    available_slots = check_availability(target_service.get("id"))
    if not available_slots:
        print("\n⚠️  No slots available.")
        exit(1)

    # Step 4: Create booking
    create_booking(available_slots[0], target_resource.get("id"))

    print("\n--- INTEGRATION TEST COMPLETE ✅ ---")